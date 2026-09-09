import { Router } from 'express'
import { z } from 'zod'
import { PriceOverride, OVERRIDE_SCOPES, OVERRIDE_TYPES } from '../../models/PriceOverride.js'
import { Organization } from '../../models/Organization.js'
import { User } from '../../models/User.js'
import { Product } from '../../models/Product.js'
import { Category } from '../../models/Category.js'
import { CustomerTier } from '../../models/CustomerTier.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { objectId } from '../../schemas/common.js'
import { calculatePrice } from '../../services/pricing/resolvePrice.js'

export const adminPriceOverridesRouter = Router()

const overrideBody = z
  .object({
    scope: z.enum(OVERRIDE_SCOPES),
    scopeId: objectId,
    product: objectId.nullable().optional(),
    category: objectId.nullable().optional(),
    overrideType: z.enum(OVERRIDE_TYPES),
    value: z.number().min(0).max(100_000_000),
    baseTier: z.string().trim().toUpperCase().max(24).optional(),
    validFrom: z.coerce.date().nullable().optional(),
    validTo: z.coerce.date().nullable().optional(),
    isActive: z.boolean().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()

/** Every reference must exist, or the override silently never applies. */
async function assertReferencesExist(body) {
  if (body.scope === 'ORGANIZATION') {
    if (!(await Organization.exists({ _id: body.scopeId }))) {
      throw ApiError.unprocessable('That organization does not exist')
    }
  } else if (body.scope === 'USER') {
    if (!(await User.exists({ _id: body.scopeId }))) {
      throw ApiError.unprocessable('That customer does not exist')
    }
  }
  if (body.product && !(await Product.exists({ _id: body.product }))) {
    throw ApiError.unprocessable('That product does not exist')
  }
  if (body.category && !(await Category.exists({ _id: body.category }))) {
    throw ApiError.unprocessable('That category does not exist')
  }
  if (body.baseTier) {
    const tier = await CustomerTier.findOne({ code: body.baseTier, isActive: true }).lean()
    if (!tier) throw ApiError.unprocessable(`Unknown or inactive tier: ${body.baseTier}`)
  }
}

adminPriceOverridesRouter.get(
  '/',
  validate({
    query: z
      .object({
        scope: z.enum(OVERRIDE_SCOPES).optional(),
        scopeId: objectId.optional(),
        isActive: z.enum(['true', 'false']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const { scope, scopeId, isActive, page, limit } = req.validatedQuery
    const filter = {}
    if (scope) filter.scope = scope
    if (scopeId) filter.scopeId = scopeId
    if (isActive) filter.isActive = isActive === 'true'

    const [items, total] = await Promise.all([
      PriceOverride.find(filter)
        .populate('product', 'name slug')
        .populate('category', 'name slug')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PriceOverride.countDocuments(filter),
    ])

    // Resolve the scope holder's name — an admin needs to see WHOSE rate this
    // is, not an ObjectId.
    const orgIds = items.filter((i) => i.scope === 'ORGANIZATION').map((i) => i.scopeId)
    const userIds = items.filter((i) => i.scope === 'USER').map((i) => i.scopeId)
    const [orgs, users] = await Promise.all([
      Organization.find({ _id: { $in: orgIds } }).select('name').lean(),
      User.find({ _id: { $in: userIds } }).select('name email').lean(),
    ])
    const names = new Map([
      ...orgs.map((o) => [String(o._id), o.name]),
      ...users.map((u) => [String(u._id), `${u.name} (${u.email})`]),
    ])

    res.json({
      ok: true,
      data: items.map((o) => ({
        ...o,
        id: String(o._id),
        scopeName: names.get(String(o.scopeId)) ?? '(deleted)',
      })),
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  }),
)

adminPriceOverridesRouter.post(
  '/',
  validate({ body: overrideBody }),
  asyncHandler(async (req, res) => {
    const body = req.validatedBody
    await assertReferencesExist(body)
    const override = new PriceOverride({ ...body, createdBy: req.user._id })
    await override.save()
    res.status(201).json({ ok: true, data: override.toJSON() })
  }),
)

adminPriceOverridesRouter.patch(
  '/:id',
  validate({ params: z.object({ id: objectId }).strict(), body: overrideBody.partial() }),
  asyncHandler(async (req, res) => {
    const override = await PriceOverride.findById(req.validatedParams.id)
    if (!override) throw ApiError.notFound('Override not found')
    const body = req.validatedBody
    await assertReferencesExist({ ...override.toObject(), ...body })
    Object.assign(override, body)
    await override.save()
    res.json({ ok: true, data: override.toJSON() })
  }),
)

adminPriceOverridesRouter.delete(
  '/:id',
  validate({ params: z.object({ id: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    const deleted = await PriceOverride.findByIdAndDelete(req.validatedParams.id)
    if (!deleted) throw ApiError.notFound('Override not found')
    res.json({ ok: true, data: { id: req.validatedParams.id } })
  }),
)

/**
 * Preview what a contracted rate actually produces, before saving it.
 *
 * Calls the same calculatePrice() the customer endpoint uses, so an admin
 * agreeing a rate sees the exact figure the customer will be quoted — rather
 * than doing the arithmetic in their head and discovering the difference
 * after the contract is signed.
 */
adminPriceOverridesRouter.post(
  '/preview',
  validate({
    body: z
      .object({
        productId: objectId,
        tier: z.string().trim().toUpperCase().max(24).default('B2C'),
        overrideType: z.enum(OVERRIDE_TYPES),
        value: z.number().min(0),
        baseTier: z.string().trim().toUpperCase().max(24).optional(),
        quantity: z.coerce.number().int().min(1).default(1),
        width: z.coerce.number().positive().optional(),
        height: z.coerce.number().positive().optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const { productId, tier, overrideType, value, baseTier, quantity, width, height } = req.validatedBody
    const product = await Product.findById(productId).lean()
    if (!product) throw ApiError.notFound('Product not found')

    const input = { quantity, width, height }
    const standard = calculatePrice({ product, tierCode: tier, input })
    const contracted = calculatePrice({
      product,
      tierCode: tier,
      input,
      override: { overrideType, value, baseTier: baseTier ?? tier },
    })

    res.json({
      ok: true,
      data: {
        standard,
        contracted,
        saving:
          standard.quotable && contracted.quotable
            ? Math.round((standard.total - contracted.total) * 100) / 100
            : null,
      },
    })
  }),
)
