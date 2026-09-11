import { Router } from 'express'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { Order, nextOrderNumber } from '../models/Order.js'
import { validate } from '../middleware/validate.js'
import { asyncHandler, ApiError } from '../utils/ApiError.js'
import { objectId } from '../schemas/common.js'
import { priceCart } from '../services/cart.js'
import {
  isPaymentsConfigured,
  createProviderOrder,
  verifyPaymentSignature,
} from '../services/payments.js'
import { env } from '../config/env.js'
import { customerSafeCart, customerSafeOrder } from '../services/reseller.js'

export const ordersRouter = Router()

const checkoutLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: { message: 'Too many checkout attempts — please slow down.' } },
})

/**
 * Cart lines. Note again what is absent: no price, no total, no tier.
 * `.strict()` rejects any attempt to add one.
 */
const cartLine = z
  .object({
    slug: z.string().trim().min(1).max(160),
    quantity: z.coerce.number().int().min(1).max(1_000_000).default(1),
    width: z.coerce.number().positive().max(10_000).optional(),
    height: z.coerce.number().positive().max(10_000).optional(),
    selections: z
      .array(z.object({ group: z.string().trim().max(40), value: z.string().trim().max(60) }).strict())
      .max(40)
      .default([]),
  })
  .strict()

const addressSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(6).max(24),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(80),
    state: z.string().trim().min(1).max(80),
    pincode: z.string().trim().min(4).max(12),
    country: z.string().trim().max(80).default('India'),
  })
  .strict()

/** Price a cart. Called on every cart view — the client never adds up totals. */
ordersRouter.post(
  '/cart/price',
  validate({ body: z.object({ lines: z.array(cartLine).max(50).default([]) }).strict() }),
  asyncHandler(async (req, res) => {
    const priced = await priceCart(req.validatedBody.lines, req.user)
    res.json({ ok: true, data: customerSafeCart(priced) })
  }),
)

/**
 * Create an order and its payment intent.
 *
 * The cart is RE-PRICED here, from scratch, immediately before the payment is
 * created. Whatever the client believed the total was is irrelevant; if a rate
 * changed since the item was added, the customer pays the current one and the
 * order reflects it.
 */
ordersRouter.post(
  '/orders',
  checkoutLimiter,
  validate({
    body: z
      .object({
        lines: z.array(cartLine).min(1).max(50),
        shippingAddress: addressSchema,
        billingAddress: addressSchema.optional(),
        customerNote: z.string().trim().max(1000).optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    if (!req.user) throw ApiError.unauthorized('Sign in to place an order')
    if (!isPaymentsConfigured) {
      throw ApiError.serviceUnavailable(
        'Online payment is not configured yet. Please request a quote and we will invoice you directly.',
      )
    }

    const { lines, shippingAddress, billingAddress, customerNote } = req.validatedBody

    // Authoritative pricing, server-side, right now.
    const priced = await priceCart(lines, req.user)

    if (priced.issues.length) {
      throw ApiError.unprocessable('Some items need attention before checkout', priced.issues)
    }
    if (!priced.items.length) throw ApiError.badRequest('Your cart is empty')
    if (priced.grandTotal <= 0) throw ApiError.unprocessable('This order has no payable amount')

    const orderNumber = await nextOrderNumber()

    const order = new Order({
      orderNumber,
      user: req.user._id,
      organization: req.user.organization ?? null,
      customer: {
        name: req.user.name,
        email: req.user.email,
        phone: req.user.phone ?? shippingAddress.phone,
        gstin: req.user.businessProfile?.gstin ?? null,
      },
      items: priced.items,
      subtotal: priced.subtotal,
      taxTotal: priced.taxTotal,
      shippingTotal: priced.shippingTotal,
      grandTotal: priced.grandTotal,
      shippingAddress,
      billingAddress: billingAddress ?? shippingAddress,
      customerNote,
      status: 'PENDING_PAYMENT',
      // Reseller sale: who earns, and how much — fixed now, like the prices.
      ...(priced.reseller
        ? {
            reseller: priced.reseller._id,
            resellerSnapshot: {
              name: priced.reseller.name,
              storeName: priced.reseller.reseller?.storeName ?? priced.reseller.name,
              code: priced.reseller.reseller?.code ?? null,
            },
            commissionTotal: priced.commissionTotal,
          }
        : {}),
    })
    order.pushTimeline('PENDING_PAYMENT', req.user._id, 'Order created')

    // Amount comes from the server-computed total — never from the request.
    const providerOrder = await createProviderOrder({
      amount: order.grandTotal,
      receipt: orderNumber,
      notes: { orderNumber, customerEmail: req.user.email },
    })

    order.payment.providerOrderId = providerOrder.id
    await order.save()

    res.status(201).json({
      ok: true,
      data: {
        orderId: String(order._id),
        orderNumber,
        amount: order.grandTotal,
        currency: order.currency,
        // The PUBLIC key id — safe to send; the secret never leaves the server.
        razorpayKeyId: env.RAZORPAY_KEY_ID,
        razorpayOrderId: providerOrder.id,
        customer: order.customer,
      },
    })
  }),
)

/**
 * Verify payment after the customer completes Razorpay checkout.
 *
 * The signature is the proof, not the fact that this endpoint was called —
 * anyone can POST here. Without a valid HMAC the order is never marked paid.
 */
ordersRouter.post(
  '/orders/:id/verify',
  validate({
    params: z.object({ id: objectId }).strict(),
    body: z
      .object({
        razorpay_order_id: z.string().trim().min(1).max(120),
        razorpay_payment_id: z.string().trim().min(1).max(120),
        razorpay_signature: z.string().trim().min(1).max(256),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    if (!req.user) throw ApiError.unauthorized('Sign in to continue')

    const order = await Order.findOne({ _id: req.validatedParams.id, user: req.user._id })
    if (!order) throw ApiError.notFound('Order not found')

    // Idempotent: the webhook may have confirmed this already.
    if (order.payment.status === 'PAID') {
      return res.json({ ok: true, data: { status: order.status, orderNumber: order.orderNumber } })
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.validatedBody

    // The payment must belong to THIS order — otherwise a valid signature from
    // a different (cheaper) order could be replayed here.
    if (razorpay_order_id !== order.payment.providerOrderId) {
      throw ApiError.badRequest('This payment does not belong to this order')
    }

    const valid = verifyPaymentSignature({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
    })

    if (!valid) {
      order.payment.status = 'FAILED'
      order.payment.failureReason = 'Signature verification failed'
      order.status = 'PAYMENT_FAILED'
      order.pushTimeline('PAYMENT_FAILED', req.user._id, 'Signature verification failed')
      await order.save()
      throw ApiError.badRequest('Payment could not be verified')
    }

    order.payment.status = 'PAID'
    order.payment.providerPaymentId = razorpay_payment_id
    order.payment.signatureVerified = true
    order.payment.paidAt = new Date()
    order.status = 'PAID'
    order.pushTimeline('PAID', req.user._id, `Payment ${razorpay_payment_id} verified`)
    await order.save()

    res.json({ ok: true, data: { status: order.status, orderNumber: order.orderNumber } })
  }),
)

/** The customer's own order history. Scoped to req.user — never by an id in the query. */
ordersRouter.get(
  '/orders',
  validate({
    query: z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    if (!req.user) throw ApiError.unauthorized('Sign in to view your orders')
    const { page, limit } = req.validatedQuery

    const filter = { user: req.user._id }
    const [items, total] = await Promise.all([
      Order.find(filter)
        .select('orderNumber status grandTotal currency items createdAt payment.status')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Order.countDocuments(filter),
    ])

    res.json({
      ok: true,
      data: items.map((o) => ({
        id: String(o._id),
        orderNumber: o.orderNumber,
        status: o.status,
        paymentStatus: o.payment?.status,
        grandTotal: o.grandTotal,
        currency: o.currency,
        itemCount: o.items?.length ?? 0,
        firstItem: o.items?.[0]?.name ?? null,
        createdAt: o.createdAt,
      })),
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  }),
)

ordersRouter.get(
  '/orders/:id',
  validate({ params: z.object({ id: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    if (!req.user) throw ApiError.unauthorized('Sign in to view this order')
    // Ownership is part of the QUERY, so another customer's order is never
    // loaded and then checked.
    const order = await Order.findOne({ _id: req.validatedParams.id, user: req.user._id }).lean()
    if (!order) throw ApiError.notFound('Order not found')
    // The reseller's cost and commission are between us and the reseller.
    res.json({ ok: true, data: { ...customerSafeOrder(order), id: String(order._id) } })
  }),
)
