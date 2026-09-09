import { Router } from 'express'
import { z } from 'zod'
import slugify from 'slugify'
import { Product, PRICING_MODELS, PURCHASE_MODES } from '../../models/Product.js'
import { Category } from '../../models/Category.js'
import { CustomerTier } from '../../models/CustomerTier.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { objectId, tierAmountMap } from '../../schemas/common.js'
import { calculatePrice } from '../../services/pricing/resolvePrice.js'

export const adminProductsRouter = Router()

const pricingSchema = z
  .object({
    unit: z.string().trim().max(24).nullable().optional(),
    amounts: tierAmountMap.optional(),
    rates: tierAmountMap.optional(),
    slabs: z
      .array(
        z
          .object({
            minQty: z.number().int().min(1),
            maxQty: z.number().int().min(1).nullable().optional(),
            amounts: tierAmountMap,
          })
          .strict(),
      )
      .max(30)
      .optional(),
    minChargeableArea: z.number().min(0).nullable().optional(),
    roundUpTo: z.number().min(0).nullable().optional(),
    optionsAffectPrice: z.boolean().optional(),
  })
  .strict()

const productBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: z.string().trim().min(1).max(160).optional(),
    categories: z.array(objectId).min(1).max(12),
    primaryCategory: objectId.optional(),
    shortDescription: z.string().trim().max(400).optional(),
    description: z.string().trim().max(8000).optional(),
    images: z
      .array(
        z
          .object({
            url: z.string().url(),
            publicId: z.string().optional(),
            alt: z.string().max(200).optional(),
            isPrimary: z.boolean().optional(),
            order: z.number().int().optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    legacyImageUrl: z.string().url().nullable().optional(),
    specifications: z.array(z.string().trim().max(300)).max(40).optional(),
    applications: z.array(z.string().trim().max(300)).max(40).optional(),
    customization: z.array(z.string().trim().max(300)).max(40).optional(),
    materials: z.array(z.string().trim().max(300)).max(40).optional(),
    sizes: z.array(z.string().trim().max(300)).max(40).optional(),
    moq: z
      .object({ qty: z.number().min(0).nullable(), unit: z.string().trim().max(40).nullable() })
      .strict()
      .optional(),
    hsnCode: z.string().trim().max(20).nullable().optional(),
    taxPercent: z.number().min(0).max(100).nullable().optional(),
    pricingModel: z.enum(PRICING_MODELS).optional(),
    purchaseMode: z.enum(PURCHASE_MODES).optional(),
    pricing: pricingSchema.nullable().optional(),
    options: z
      .array(
        z
          .object({
            optionGroup: objectId,
            order: z.number().int().optional(),
            required: z.boolean().optional(),
            labelOverride: z.string().trim().max(120).nullable().optional(),
            deltaOverrides: tierAmountMap.optional(),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    visibility: z
      .object({ b2c: z.boolean(), b2b: z.boolean(), corporate: z.boolean() })
      .partial()
      .strict()
      .optional(),
    featured: z.boolean().optional(),
    isActive: z.boolean().optional(),
    seo: z
      .object({
        title: z.string().trim().max(200).optional(),
        description: z.string().trim().max(400).optional(),
      })
      .strict()
      .optional(),
    order: z.number().int().optional(),
  })
  .strict()

/** Every tier code referenced in a pricing payload must actually exist. */
async function assertTierCodesExist(pricing) {
  if (!pricing) return
  const codes = new Set()
  for (const key of Object.keys(pricing.amounts ?? {})) codes.add(key)
  for (const key of Object.keys(pricing.rates ?? {})) codes.add(key)
  for (const slab of pricing.slabs ?? []) {
    for (const key of Object.keys(slab.amounts ?? {})) codes.add(key)
  }
  if (!codes.size) return

  const found = await CustomerTier.find({ code: { $in: [...codes] } }).select('code').lean()
  const known = new Set(found.map((t) => t.code))
  const unknown = [...codes].filter((c) => !known.has(c))
  if (unknown.length) {
    throw ApiError.unprocessable(`Unknown customer tier(s): ${unknown.join(', ')}`, { unknown })
  }
}

/** Recompute the cached ancestor union whenever categories change. */
async function computeAncestors(categoryIds) {
  const cats = await Category.find({ _id: { $in: categoryIds } }).select('ancestors').lean()
  if (cats.length !== categoryIds.length) throw ApiError.unprocessable('One or more categories do not exist')
  const union = new Set()
  for (const c of cats) for (const a of c.ancestors ?? []) union.add(String(a))
  return [...union]
}

adminProductsRouter.get(
  '/',
  validate({
    query: z
      .object({
        search: z.string().trim().max(80).optional(),
        category: objectId.optional(),
        isActive: z.enum(['true', 'false']).optional(),
        needsImage: z.enum(['true']).optional(),
        needsPrice: z.enum(['true']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const { search, category, isActive, needsImage, needsPrice, page, limit } = req.validatedQuery
    const filter = {}
    if (search) filter.name = { $regex: search, $options: 'i' }
    if (category) filter.categories = category
    if (isActive) filter.isActive = isActive === 'true'
    // Work queues for the team: what still needs a real photo, what needs a price.
    if (needsImage) filter.$or = [{ images: { $size: 0 } }, { images: { $exists: false } }]
    if (needsPrice) filter.pricingModel = 'QUOTE_ONLY'

    const [items, total] = await Promise.all([
      Product.find(filter)
        .populate('categories', 'name slug')
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ])

    res.json({
      ok: true,
      data: items.map((p) => ({
        ...p,
        id: String(p._id),
        needsImage: !p.images?.length,
        hasLegacyImage: Boolean(p.legacyImageUrl),
      })),
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  }),
)

adminProductsRouter.get(
  '/:id',
  validate({ params: z.object({ id: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    const product = await Product.findById(req.validatedParams.id)
      .populate('categories', 'name slug')
      .populate('options.optionGroup', 'code label inputType unit values')
      .lean()
    if (!product) throw ApiError.notFound('Product not found')
    res.json({ ok: true, data: { ...product, id: String(product._id) } })
  }),
)

adminProductsRouter.post(
  '/',
  validate({ body: productBody }),
  asyncHandler(async (req, res) => {
    const body = req.validatedBody
    await assertTierCodesExist(body.pricing)

    const slug = slugify(body.slug ?? body.name, { lower: true, strict: true })
    const categoryAncestors = await computeAncestors(body.categories)

    const product = new Product({ ...body, slug, categoryAncestors, createdBy: req.user._id })
    await product.save()

    res.status(201).json({ ok: true, data: product.toJSON() })
  }),
)

adminProductsRouter.patch(
  '/:id',
  validate({ params: z.object({ id: objectId }).strict(), body: productBody.partial() }),
  asyncHandler(async (req, res) => {
    const product = await Product.findById(req.validatedParams.id)
    if (!product) throw ApiError.notFound('Product not found')

    const body = req.validatedBody
    await assertTierCodesExist(body.pricing)

    // A slug change breaks an indexed URL, so it is never a side effect of
    // editing the name — it only happens when a slug is passed explicitly.
    if (body.slug) {
      product.slug = slugify(body.slug, { lower: true, strict: true })
    }
    const { slug: _ignored, ...rest } = body
    Object.assign(product, rest)

    if (body.categories) {
      product.categoryAncestors = await computeAncestors(body.categories)
    }
    // Uploading a real image retires the migrated hotlink.
    if (body.images?.length) product.legacyImageUrl = null

    product.updatedBy = req.user._id
    await product.save()

    res.json({ ok: true, data: product.toJSON() })
  }),
)

/**
 * Admin price preview — calls the SAME resolver the public endpoint uses, so
 * what an admin sees while setting prices is exactly what a customer is
 * quoted. A second implementation here is how those two drift apart.
 */
adminProductsRouter.post(
  '/:id/preview-price',
  validate({
    params: z.object({ id: objectId }).strict(),
    body: z
      .object({
        tier: z.string().trim().max(24),
        quantity: z.coerce.number().int().min(1).default(1),
        width: z.coerce.number().positive().optional(),
        height: z.coerce.number().positive().optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const product = await Product.findById(req.validatedParams.id).lean()
    if (!product) throw ApiError.notFound('Product not found')

    const { tier, quantity, width, height } = req.validatedBody
    // Admins may preview ANY tier — that is the point of the screen. This is
    // safe because the route is behind requireAdmin; the public endpoint never
    // accepts a tier from the caller.
    const result = calculatePrice({ product, tierCode: tier, input: { quantity, width, height } })
    res.json({ ok: true, data: result })
  }),
)

adminProductsRouter.delete(
  '/:id',
  validate({ params: z.object({ id: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    const product = await Product.findByIdAndDelete(req.validatedParams.id)
    if (!product) throw ApiError.notFound('Product not found')
    res.json({ ok: true, data: { id: req.validatedParams.id } })
  }),
)
