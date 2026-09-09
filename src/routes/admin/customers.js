import { Router } from 'express'
import { z } from 'zod'
import { User } from '../../models/User.js'
import { CustomerTier } from '../../models/CustomerTier.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { objectId } from '../../schemas/common.js'

export const adminCustomersRouter = Router()

const PENDING = ['B2B_PENDING', 'CORPORATE_PENDING']

adminCustomersRouter.get(
  '/',
  validate({
    query: z
      .object({
        status: z.string().trim().max(40).optional(),
        accountType: z.enum(['B2C', 'B2B', 'CORPORATE']).optional(),
        search: z.string().trim().max(120).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const { status, accountType, search, page, limit } = req.validatedQuery

    const filter = { role: 'CUSTOMER' }
    if (status === 'PENDING') filter.status = { $in: PENDING }
    else if (status) filter.status = status
    if (accountType) filter.accountType = accountType
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { 'businessProfile.businessName': { $regex: search, $options: 'i' } },
      ]
    }

    const [items, total, pendingCount] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      User.countDocuments(filter),
      User.countDocuments({ role: 'CUSTOMER', status: { $in: PENDING } }),
    ])

    res.json({
      ok: true,
      data: items.map((u) => ({
        id: String(u._id),
        name: u.name,
        email: u.email,
        phone: u.phone ?? null,
        accountType: u.accountType,
        status: u.status,
        resolvedTier: u.resolvedTier,
        businessProfile: u.businessProfile ?? null,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt ?? null,
        rejectionReason: u.rejectionReason ?? null,
      })),
      meta: { page, limit, total, pages: Math.ceil(total / limit), pendingCount },
    })
  }),
)

/**
 * Approve an application.
 *
 * This is the ONLY place in the system that writes `resolvedTier` to anything
 * other than B2C, and it requires an authenticated admin. There is no code
 * path by which a customer can reach it.
 */
adminCustomersRouter.patch(
  '/:id/approve',
  validate({
    params: z.object({ id: objectId }).strict(),
    body: z
      .object({
        // Optional: approve onto a tier other than the one applied for —
        // e.g. a corporate applicant granted trade pricing instead.
        tier: z.string().trim().max(24).optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.validatedParams.id)
    if (!user) throw ApiError.notFound('Customer not found')
    if (!PENDING.includes(user.status)) {
      throw ApiError.conflict(`This account is not awaiting approval (status: ${user.status})`)
    }

    const targetCode = req.validatedBody.tier ?? user.accountType
    const tier = await CustomerTier.findOne({ code: targetCode, isActive: true })
    if (!tier) throw ApiError.unprocessable(`Unknown or inactive tier: ${targetCode}`)

    user.resolvedTier = tier.code
    user.accountType = tier.code === 'CORPORATE' ? 'CORPORATE' : tier.code === 'B2B' ? 'B2B' : user.accountType
    user.status = tier.code === 'CORPORATE' ? 'CORPORATE_APPROVED' : 'B2B_APPROVED'
    user.approvedBy = req.user._id
    user.approvedAt = new Date()
    user.rejectionReason = null
    await user.save()

    res.json({
      ok: true,
      data: {
        id: String(user._id),
        status: user.status,
        resolvedTier: user.resolvedTier,
        message: `${user.name} now sees ${tier.name} pricing.`,
      },
    })
  }),
)

adminCustomersRouter.patch(
  '/:id/reject',
  validate({
    params: z.object({ id: objectId }).strict(),
    body: z.object({ reason: z.string().trim().min(1).max(500) }).strict(),
  }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.validatedParams.id)
    if (!user) throw ApiError.notFound('Customer not found')
    if (!PENDING.includes(user.status)) {
      throw ApiError.conflict(`This account is not awaiting approval (status: ${user.status})`)
    }

    user.status = user.accountType === 'CORPORATE' ? 'CORPORATE_REJECTED' : 'B2B_REJECTED'
    // The account keeps working — at retail pricing. A rejected trade
    // application should not lock someone out of buying.
    user.resolvedTier = 'B2C'
    user.rejectionReason = req.validatedBody.reason
    user.approvedBy = req.user._id
    user.approvedAt = new Date()
    await user.save()

    res.json({
      ok: true,
      data: { id: String(user._id), status: user.status, resolvedTier: user.resolvedTier },
    })
  }),
)

/** Revoke an approved tier — back to retail, without deleting the account. */
adminCustomersRouter.patch(
  '/:id/revoke',
  validate({
    params: z.object({ id: objectId }).strict(),
    body: z.object({ reason: z.string().trim().max(500).optional() }).strict(),
  }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.validatedParams.id)
    if (!user) throw ApiError.notFound('Customer not found')

    user.resolvedTier = 'B2C'
    user.status = 'ACTIVE'
    user.rejectionReason = req.validatedBody.reason ?? null
    // Invalidates every live session for this user, so the change takes
    // effect immediately rather than whenever their token happens to expire.
    user.tokenVersion += 1
    await user.save()

    res.json({ ok: true, data: { id: String(user._id), resolvedTier: 'B2C', status: user.status } })
  }),
)
