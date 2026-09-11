import { Router } from 'express'
import { z } from 'zod'
import { User } from '../models/User.js'
import { Product } from '../models/Product.js'
import { Category } from '../models/Category.js'
import { Order } from '../models/Order.js'
import { ResellerPrice } from '../models/ResellerPrice.js'
import { validate } from '../middleware/validate.js'
import { asyncHandler, ApiError } from '../utils/ApiError.js'
import { objectId } from '../schemas/common.js'
import { resolveDisplayPrice } from '../services/pricing/resolvePrice.js'
import { loadMarkups, commissionState, COMMISSION_HOLD_DAYS } from '../services/reseller.js'

/**
 * The reseller's own surface: apply, dashboard, prices, customers, orders.
 *
 * Everything is scoped to req.user — a reseller id never comes from the
 * request, so one reseller cannot read another's customers or earnings.
 */
export const resellerRouter = Router()

const markupValue = z.number().min(0, 'A markup cannot be negative').max(1000).nullable()

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function requireReseller(req) {
  if (!req.user) throw ApiError.unauthorized('Sign in to continue')
  if (!['ACTIVE', 'PAUSED'].includes(req.user.reseller?.status)) {
    throw ApiError.forbidden('This is available to approved resellers only')
  }
}

/** Apply to become a reseller. Approved trade accounts only. */
resellerRouter.post(
  '/apply',
  validate({ body: z.object({ storeName: z.string().trim().min(2).max(80) }).strict() }),
  asyncHandler(async (req, res) => {
    if (!req.user) throw ApiError.unauthorized('Sign in to apply')
    // A reseller earns the gap between their trade price and what their
    // customer pays — without trade pricing there is no gap.
    if (!req.user.resolvedTier || req.user.resolvedTier === 'B2C') {
      throw ApiError.forbidden('Reselling is open to approved trade accounts. Apply for trade pricing first.')
    }
    if (req.user.reseller?.status) {
      throw ApiError.conflict(`You already have a reseller account (${req.user.reseller.status.toLowerCase()})`)
    }

    const { storeName } = req.validatedBody
    await User.updateOne(
      { _id: req.user._id },
      { $set: { 'reseller.status': 'PENDING', 'reseller.storeName': storeName, 'reseller.appliedAt': new Date() } },
    )
    res.json({ ok: true, data: { status: 'PENDING', storeName } })
  }),
)

/** Dashboard summary. */
resellerRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    requireReseller(req)
    const me = req.user

    const [customers, orders] = await Promise.all([
      User.countDocuments({ referredBy: me._id }),
      Order.find({ reseller: me._id, 'payment.status': { $in: ['PAID', 'REFUNDED'] } })
        .select('status payment.status subtotal commissionTotal deliveredAt timeline updatedAt')
        .lean(),
    ])

    let orderCount = 0
    let sales = 0
    let pending = 0
    let ready = 0
    for (const o of orders) {
      const { state } = commissionState(o)
      if (state === 'CANCELLED') continue
      orderCount += 1
      sales += o.subtotal ?? 0
      if (state === 'READY') ready += o.commissionTotal ?? 0
      else pending += o.commissionTotal ?? 0
    }

    res.json({
      ok: true,
      data: {
        status: me.reseller.status,
        code: me.reseller.code,
        storeName: me.reseller.storeName ?? me.name,
        defaultMarkupPercent: me.reseller.defaultMarkupPercent ?? null,
        holdDays: COMMISSION_HOLD_DAYS,
        stats: {
          customers,
          orders: orderCount,
          sales: round(sales),
          commissionPending: round(pending),
          commissionReady: round(ready),
        },
      },
    })
  }),
)

resellerRouter.patch(
  '/settings',
  validate({
    body: z
      .object({
        storeName: z.string().trim().min(2).max(80).optional(),
        defaultMarkupPercent: markupValue.optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    requireReseller(req)
    const { storeName, defaultMarkupPercent } = req.validatedBody
    const $set = {}
    if (storeName !== undefined) $set['reseller.storeName'] = storeName
    if (defaultMarkupPercent !== undefined) $set['reseller.defaultMarkupPercent'] = defaultMarkupPercent
    if (Object.keys($set).length) await User.updateOne({ _id: req.user._id }, { $set })
    res.json({ ok: true, data: { storeName, defaultMarkupPercent } })
  }),
)

/**
 * The catalogue as the reseller sees it: their cost, what their customer
 * pays, and what they earn — each as a "from" figure for the smallest order.
 */
resellerRouter.get(
  '/products',
  validate({
    query: z
      .object({
        search: z.string().trim().min(2).max(80).optional(),
        category: z.string().trim().min(1).max(120).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    requireReseller(req)
    const me = req.user
    const { search, category, page, limit } = req.validatedQuery

    // Only products the reseller's retail customers can actually buy.
    const filter = { isActive: true, 'visibility.b2c': true }
    if (search) filter.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
    if (category) {
      const cat = await Category.findOne({ slug: category, isActive: true }).select('_id').lean()
      if (!cat) throw ApiError.notFound('Category not found')
      filter.$or = [{ categories: cat._id }, { categoryAncestors: cat._id }]
    }

    const [items, total] = await Promise.all([
      Product.find(filter)
        .select('name slug images legacyImageUrl pricingModel purchaseMode pricing')
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ])

    const markups = await loadMarkups(me._id, items.map((p) => p._id))
    const tier = me.resolvedTier ?? 'B2C'
    const fallback = me.reseller?.defaultMarkupPercent ?? null

    res.json({
      ok: true,
      data: items.map((p) => {
        const cost = resolveDisplayPrice({ product: p, tierCode: tier })
        const retail = resolveDisplayPrice({ product: p, tierCode: 'B2C' })
        const own = markups.get(String(p._id)) ?? null
        const effective = own ?? fallback

        let sellFrom = null
        if (cost) {
          sellFrom =
            effective === null
              ? retail
                ? Math.max(retail.from, cost.from)
                : null
              : round(cost.from * (1 + effective / 100))
        }

        const image = p.images?.find((i) => i.isPrimary)?.url ?? p.images?.[0]?.url ?? p.legacyImageUrl ?? null
        return {
          id: String(p._id),
          name: p.name,
          slug: p.slug,
          image,
          unit: cost?.unit ?? retail?.unit ?? null,
          quoteOnly: p.pricingModel === 'QUOTE_ONLY' || p.purchaseMode === 'QUOTE_ONLY',
          costFrom: cost?.from ?? null,
          retailFrom: retail?.from ?? null,
          markupPercent: own,
          sellFrom,
          earnFrom: sellFrom !== null && cost ? round(sellFrom - cost.from) : null,
        }
      }),
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  }),
)

/** Set (or clear, with null) the reseller's markup on one product. */
resellerRouter.put(
  '/products/:productId/markup',
  validate({
    params: z.object({ productId: objectId }).strict(),
    body: z.object({ markupPercent: markupValue }).strict(),
  }),
  asyncHandler(async (req, res) => {
    requireReseller(req)
    const { productId } = req.validatedParams
    const { markupPercent } = req.validatedBody

    if (!(await Product.exists({ _id: productId }))) throw ApiError.notFound('Product not found')

    if (markupPercent === null) {
      await ResellerPrice.deleteOne({ reseller: req.user._id, product: productId })
    } else {
      await ResellerPrice.findOneAndUpdate(
        { reseller: req.user._id, product: productId },
        { $set: { markupPercent } },
        { upsert: true, runValidators: true },
      )
    }
    res.json({ ok: true, data: { productId, markupPercent } })
  }),
)

/**
 * The reseller's customers: name, city and orders. Contact details are
 * deliberately NOT included — that needs the customer's consent first.
 */
resellerRouter.get(
  '/customers',
  asyncHandler(async (req, res) => {
    requireReseller(req)
    const me = req.user

    const [customers, stats] = await Promise.all([
      User.find({ referredBy: me._id }).select('name createdAt').sort({ createdAt: -1 }).limit(500).lean(),
      Order.aggregate([
        { $match: { reseller: me._id, 'payment.status': 'PAID' } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: '$user',
            orders: { $sum: 1 },
            spent: { $sum: '$subtotal' },
            lastOrderAt: { $first: '$createdAt' },
            city: { $first: '$shippingAddress.city' },
          },
        },
      ]),
    ])
    const byUser = new Map(stats.map((s) => [String(s._id), s]))

    res.json({
      ok: true,
      data: customers.map((c) => {
        const s = byUser.get(String(c._id))
        return {
          id: String(c._id),
          name: c.name,
          joinedAt: c.createdAt,
          orders: s?.orders ?? 0,
          spent: round(s?.spent ?? 0),
          lastOrderAt: s?.lastOrderAt ?? null,
          city: s?.city ?? null,
        }
      }),
    })
  }),
)

/** Orders placed by the reseller's customers, with the commission on each. */
resellerRouter.get(
  '/orders',
  asyncHandler(async (req, res) => {
    requireReseller(req)

    const orders = await Order.find({ reseller: req.user._id, 'payment.status': { $in: ['PAID', 'REFUNDED'] } })
      .select('orderNumber createdAt status payment.status customer.name shippingAddress.city items.name subtotal commissionTotal deliveredAt timeline updatedAt')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean()

    res.json({
      ok: true,
      data: orders.map((o) => {
        const { state, readyOn } = commissionState(o)
        return {
          id: String(o._id),
          orderNumber: o.orderNumber,
          createdAt: o.createdAt,
          status: o.status,
          customerName: o.customer?.name ?? null,
          city: o.shippingAddress?.city ?? null,
          itemCount: o.items?.length ?? 0,
          firstItem: o.items?.[0]?.name ?? null,
          sale: o.subtotal,
          commission: o.commissionTotal ?? 0,
          commissionState: state,
          readyOn,
        }
      }),
    })
  }),
)
