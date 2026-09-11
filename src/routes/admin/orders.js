import { Router } from 'express'
import { z } from 'zod'
import { Order, ORDER_STATUSES } from '../../models/Order.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { objectId } from '../../schemas/common.js'

export const adminOrdersRouter = Router()

/** Statuses an admin may set by hand. Payment states are set by the payment flow. */
const MANUAL_STATUSES = ['IN_PRODUCTION', 'DISPATCHED', 'DELIVERED', 'CANCELLED', 'REFUNDED']

adminOrdersRouter.get(
  '/',
  validate({
    query: z
      .object({
        status: z.enum(ORDER_STATUSES).optional(),
        search: z.string().trim().max(120).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const { status, search, page, limit } = req.validatedQuery
    const filter = {}
    if (status) filter.status = status
    if (search) {
      filter.$or = [
        { orderNumber: { $regex: search, $options: 'i' } },
        { 'customer.email': { $regex: search, $options: 'i' } },
        { 'customer.name': { $regex: search, $options: 'i' } },
      ]
    }

    const [items, total, awaitingAction] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Order.countDocuments(filter),
      // The queue that matters operationally: paid, not yet in production.
      Order.countDocuments({ status: 'PAID' }),
    ])

    res.json({
      ok: true,
      data: items.map((o) => ({ ...o, id: String(o._id) })),
      meta: { page, limit, total, pages: Math.ceil(total / limit), awaitingAction },
    })
  }),
)

adminOrdersRouter.get(
  '/:id',
  validate({ params: z.object({ id: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.validatedParams.id).lean()
    if (!order) throw ApiError.notFound('Order not found')
    res.json({ ok: true, data: { ...order, id: String(order._id) } })
  }),
)

adminOrdersRouter.patch(
  '/:id/status',
  validate({
    params: z.object({ id: objectId }).strict(),
    body: z
      .object({
        status: z.enum(MANUAL_STATUSES),
        note: z.string().trim().max(500).optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.validatedParams.id)
    if (!order) throw ApiError.notFound('Order not found')

    const { status, note } = req.validatedBody

    // An unpaid order cannot enter production — that would be shipping goods
    // nobody has paid for.
    if (order.payment.status !== 'PAID' && ['IN_PRODUCTION', 'DISPATCHED', 'DELIVERED'].includes(status)) {
      throw ApiError.conflict(
        `This order has not been paid (payment: ${order.payment.status}). Mark it paid, or cancel it.`,
      )
    }

    order.status = status
    // The first delivery starts a reseller's 7-day commission clock.
    if (status === 'DELIVERED' && !order.deliveredAt) order.deliveredAt = new Date()
    order.pushTimeline(status, req.user._id, note ?? null)
    await order.save()

    res.json({ ok: true, data: { id: String(order._id), status: order.status } })
  }),
)
