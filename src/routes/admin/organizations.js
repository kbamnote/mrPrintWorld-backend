import { Router } from 'express'
import { z } from 'zod'
import slugify from 'slugify'
import { Organization, ACCESS_MODES, ORG_STATUSES } from '../../models/Organization.js'
import { User } from '../../models/User.js'
import { PriceOverride } from '../../models/PriceOverride.js'
import { CustomerTier } from '../../models/CustomerTier.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { objectId } from '../../schemas/common.js'

export const adminOrganizationsRouter = Router()

const orgBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: z.string().trim().max(200).optional(),
    gstin: z.string().trim().max(20).optional(),
    pan: z.string().trim().max(12).optional(),
    cin: z.string().trim().max(30).optional(),
    contact: z
      .object({
        personName: z.string().trim().max(120).optional(),
        designation: z.string().trim().max(120).optional(),
        email: z.string().trim().toLowerCase().email().optional(),
        phone: z.string().trim().max(24).optional(),
      })
      .strict()
      .optional(),
    billingAddress: z
      .object({
        line1: z.string().trim().max(200).optional(),
        line2: z.string().trim().max(200).optional(),
        city: z.string().trim().max(80).optional(),
        state: z.string().trim().max(80).optional(),
        pincode: z.string().trim().max(12).optional(),
        country: z.string().trim().max(80).optional(),
      })
      .strict()
      .optional(),
    tierCode: z.string().trim().toUpperCase().max(24).optional(),
    productAccessMode: z.enum(ACCESS_MODES).optional(),
    allowedProducts: z.array(objectId).max(500).optional(),
    allowedCategories: z.array(objectId).max(100).optional(),
    status: z.enum(ORG_STATUSES).optional(),
    internalNotes: z.string().trim().max(4000).optional(),
  })
  .strict()

async function assertTierExists(code) {
  if (!code) return
  const tier = await CustomerTier.findOne({ code, isActive: true }).lean()
  if (!tier) throw ApiError.unprocessable(`Unknown or inactive tier: ${code}`)
}

adminOrganizationsRouter.get(
  '/',
  validate({
    query: z
      .object({
        search: z.string().trim().max(120).optional(),
        status: z.enum(ORG_STATUSES).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const { search, status, page, limit } = req.validatedQuery
    const filter = {}
    if (status) filter.status = status
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { gstin: { $regex: search, $options: 'i' } },
      ]
    }

    const [items, total] = await Promise.all([
      Organization.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      Organization.countDocuments(filter),
    ])

    // Member and override counts, so an admin can see at a glance which
    // organizations actually carry a contract.
    const ids = items.map((o) => o._id)
    const [memberCounts, overrideCounts] = await Promise.all([
      User.aggregate([
        { $match: { organization: { $in: ids } } },
        { $group: { _id: '$organization', n: { $sum: 1 } } },
      ]),
      PriceOverride.aggregate([
        { $match: { scope: 'ORGANIZATION', scopeId: { $in: ids }, isActive: true } },
        { $group: { _id: '$scopeId', n: { $sum: 1 } } },
      ]),
    ])
    const members = new Map(memberCounts.map((m) => [String(m._id), m.n]))
    const overrides = new Map(overrideCounts.map((m) => [String(m._id), m.n]))

    res.json({
      ok: true,
      data: items.map((o) => ({
        ...o,
        id: String(o._id),
        memberCount: members.get(String(o._id)) ?? 0,
        overrideCount: overrides.get(String(o._id)) ?? 0,
      })),
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  }),
)

adminOrganizationsRouter.get(
  '/:id',
  validate({ params: z.object({ id: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    const org = await Organization.findById(req.validatedParams.id)
      .populate('allowedCategories', 'name slug')
      .populate('allowedProducts', 'name slug')
      .lean()
    if (!org) throw ApiError.notFound('Organization not found')

    const [members, overrides] = await Promise.all([
      User.find({ organization: org._id })
        .select('name email phone orgRole resolvedTier status lastLoginAt')
        .sort({ createdAt: 1 })
        .lean(),
      PriceOverride.find({ scope: 'ORGANIZATION', scopeId: org._id })
        .populate('product', 'name slug')
        .populate('category', 'name slug')
        .sort({ createdAt: -1 })
        .lean(),
    ])

    res.json({
      ok: true,
      data: {
        ...org,
        id: String(org._id),
        members: members.map((m) => ({ ...m, id: String(m._id) })),
        overrides: overrides.map((o) => ({ ...o, id: String(o._id) })),
      },
    })
  }),
)

adminOrganizationsRouter.post(
  '/',
  validate({ body: orgBody }),
  asyncHandler(async (req, res) => {
    const body = req.validatedBody
    await assertTierExists(body.tierCode)
    const slug = slugify(body.slug ?? body.name, { lower: true, strict: true })
    const org = new Organization({ ...body, slug, createdBy: req.user._id })
    await org.save()
    res.status(201).json({ ok: true, data: org.toJSON() })
  }),
)

adminOrganizationsRouter.patch(
  '/:id',
  validate({ params: z.object({ id: objectId }).strict(), body: orgBody.partial() }),
  asyncHandler(async (req, res) => {
    const org = await Organization.findById(req.validatedParams.id)
    if (!org) throw ApiError.notFound('Organization not found')

    const body = req.validatedBody
    await assertTierExists(body.tierCode)

    const tierChanged = body.tierCode && body.tierCode !== org.tierCode
    Object.assign(org, body)
    if (body.slug || body.name) {
      org.slug = slugify(body.slug ?? body.name, { lower: true, strict: true })
    }
    await org.save()

    // Changing the organisation's tier changes what every member is charged.
    // Bumping tokenVersion forces them onto a fresh token so the change takes
    // effect now rather than whenever each session happens to expire.
    let membersInvalidated = 0
    if (tierChanged) {
      const r = await User.updateMany({ organization: org._id }, { $inc: { tokenVersion: 1 } })
      membersInvalidated = r.modifiedCount
    }

    res.json({ ok: true, data: org.toJSON(), meta: { membersInvalidated } })
  }),
)

/** Attach an existing customer to this organization. */
adminOrganizationsRouter.post(
  '/:id/members',
  validate({
    params: z.object({ id: objectId }).strict(),
    body: z
      .object({
        email: z.string().trim().toLowerCase().email(),
        orgRole: z.enum(['OWNER', 'PURCHASER', 'VIEWER', 'ACCOUNTS']).default('PURCHASER'),
        inheritTier: z.boolean().default(true),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const org = await Organization.findById(req.validatedParams.id)
    if (!org) throw ApiError.notFound('Organization not found')

    const { email, orgRole, inheritTier } = req.validatedBody
    const user = await User.findOne({ email })
    if (!user) throw ApiError.notFound(`No customer account for ${email}. They must register first.`)
    if (user.role !== 'CUSTOMER') throw ApiError.badRequest('Only customer accounts can join an organization')
    if (user.organization && String(user.organization) !== String(org._id)) {
      throw ApiError.conflict('This customer already belongs to another organization')
    }

    user.organization = org._id
    user.orgRole = orgRole
    if (inheritTier) {
      user.resolvedTier = org.tierCode
      user.accountType = org.tierCode === 'CORPORATE' ? 'CORPORATE' : user.accountType
      user.status = org.tierCode === 'CORPORATE' ? 'CORPORATE_APPROVED' : user.status
      user.approvedBy = req.user._id
      user.approvedAt = new Date()
    }
    user.tokenVersion += 1 // take effect immediately
    await user.save()

    res.status(201).json({
      ok: true,
      data: { id: String(user._id), email: user.email, orgRole, resolvedTier: user.resolvedTier },
    })
  }),
)

adminOrganizationsRouter.delete(
  '/:id/members/:userId',
  validate({ params: z.object({ id: objectId, userId: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    const user = await User.findOne({
      _id: req.validatedParams.userId,
      organization: req.validatedParams.id,
    })
    if (!user) throw ApiError.notFound('That customer is not a member of this organization')

    user.organization = null
    user.orgRole = null
    // Removing someone from an organisation removes the contract rate they
    // held through it. Leaving them on it would be a silent price leak.
    user.resolvedTier = 'B2C'
    user.tokenVersion += 1
    await user.save()

    res.json({ ok: true, data: { id: String(user._id), resolvedTier: 'B2C' } })
  }),
)

adminOrganizationsRouter.delete(
  '/:id',
  validate({ params: z.object({ id: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    const id = req.validatedParams.id
    const memberCount = await User.countDocuments({ organization: id })
    if (memberCount > 0) {
      throw ApiError.conflict(`This organization still has ${memberCount} member(s). Remove them first.`)
    }
    const deleted = await Organization.findByIdAndDelete(id)
    if (!deleted) throw ApiError.notFound('Organization not found')
    await PriceOverride.deleteMany({ scope: 'ORGANIZATION', scopeId: id })
    res.json({ ok: true, data: { id } })
  }),
)
