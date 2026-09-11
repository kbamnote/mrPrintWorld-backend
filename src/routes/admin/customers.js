import { Router } from 'express'
import { z } from 'zod'
import { User } from '../../models/User.js'
import { CustomerTier } from '../../models/CustomerTier.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { objectId } from '../../schemas/common.js'
import { generateResellerCode } from '../../services/reseller.js'

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
    else if (status === 'RESELLER_PENDING') filter['reseller.status'] = 'PENDING'
    else if (status === 'RESELLERS') filter['reseller.status'] = { $in: ['ACTIVE', 'PAUSED'] }
    else if (status) filter.status = status
    if (accountType) filter.accountType = accountType
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { 'businessProfile.businessName': { $regex: search, $options: 'i' } },
      ]
    }

    const [items, total, pendingCount, resellerPendingCount] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      User.countDocuments(filter),
      User.countDocuments({ role: 'CUSTOMER', status: { $in: PENDING } }),
      User.countDocuments({ role: 'CUSTOMER', 'reseller.status': 'PENDING' }),
    ])

    // Which reseller each customer belongs to, in one query.
    const referrerIds = [...new Set(items.map((u) => u.referredBy).filter(Boolean).map(String))]
    const referrers = referrerIds.length
      ? await User.find({ _id: { $in: referrerIds } }).select('name reseller.storeName reseller.code').lean()
      : []
    const referrerById = new Map(referrers.map((r) => [String(r._id), r]))

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
        reseller: u.reseller?.status
          ? {
              status: u.reseller.status,
              code: u.reseller.code ?? null,
              storeName: u.reseller.storeName ?? null,
            }
          : null,
        referredBy: (() => {
          const r = u.referredBy ? referrerById.get(String(u.referredBy)) : null
          return r ? { id: String(r._id), storeName: r.reseller?.storeName ?? r.name, code: r.reseller?.code ?? null } : null
        })(),
      })),
      meta: { page, limit, total, pages: Math.ceil(total / limit), pendingCount, resellerPendingCount },
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

/**
 * Reseller standing: approve (or make someone a reseller directly), decline
 * an application, pause, resume.
 *
 * While PAUSED, the reseller's customers pay normal retail and no commission
 * is recorded — nothing is deleted, so resuming restores everything.
 */
adminCustomersRouter.patch(
  '/:id/reseller',
  validate({
    params: z.object({ id: objectId }).strict(),
    body: z
      .object({
        action: z.enum(['approve', 'decline', 'pause', 'resume']),
        storeName: z.string().trim().min(2).max(80).optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.validatedParams.id)
    if (!user) throw ApiError.notFound('Customer not found')

    const { action, storeName } = req.validatedBody
    const current = user.reseller?.status ?? null

    if (action === 'approve') {
      if (!user.resolvedTier || user.resolvedTier === 'B2C') {
        throw ApiError.conflict(
          'Approve this customer for trade pricing first — a reseller earns the gap between their trade price and what their customer pays.',
        )
      }
      if (current === 'ACTIVE') throw ApiError.conflict('Already an active reseller')
      user.reseller.status = 'ACTIVE'
      user.reseller.storeName =
        storeName ?? user.reseller.storeName ?? user.businessProfile?.businessName ?? user.name
      if (!user.reseller.code) user.reseller.code = await generateResellerCode(user.reseller.storeName)
      user.reseller.approvedAt = new Date()
      user.reseller.approvedBy = req.user._id
    } else if (action === 'decline') {
      if (current !== 'PENDING') throw ApiError.conflict('There is no reseller application to decline')
      user.reseller.status = null
    } else if (action === 'pause') {
      if (current !== 'ACTIVE') throw ApiError.conflict('Only an active reseller can be paused')
      user.reseller.status = 'PAUSED'
    } else if (action === 'resume') {
      if (current !== 'PAUSED') throw ApiError.conflict('Only a paused reseller can be resumed')
      user.reseller.status = 'ACTIVE'
    }

    await user.save()
    res.json({
      ok: true,
      data: {
        id: String(user._id),
        reseller: user.reseller.status
          ? { status: user.reseller.status, code: user.reseller.code ?? null, storeName: user.reseller.storeName ?? null }
          : null,
      },
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
    // No trade price means no margin to earn — pause reselling too. Their
    // customers fall back to normal retail pricing.
    if (user.reseller?.status === 'ACTIVE') user.reseller.status = 'PAUSED'
    // Invalidates every live session for this user, so the change takes
    // effect immediately rather than whenever their token happens to expire.
    user.tokenVersion += 1
    await user.save()

    res.json({ ok: true, data: { id: String(user._id), resolvedTier: 'B2C', status: user.status } })
  }),
)
