import { Router } from 'express'
import { z } from 'zod'
import { Product } from '../../models/Product.js'
import { Category } from '../../models/Category.js'
import { OptionGroup } from '../../models/OptionGroup.js'
import { CustomerTier } from '../../models/CustomerTier.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { resolveTierCode } from '../../services/pricing/resolvePrice.js'
import { publicProductCard, publicProductDetail, publicOptionGroup } from '../../services/serializers.js'

export const publicProductsRouter = Router()

/**
 * Build the visibility clause for a tier.
 *
 * This is a QUERY filter, never a response filter. A product the caller may not
 * see is never loaded from Mongo — so it cannot leak through a serialisation
 * mistake, a forgotten check on a new endpoint, or a debug field.
 */
function visibilityClause(tierCode) {
  const field =
    { B2C: 'visibility.b2c', B2B: 'visibility.b2b', CORPORATE: 'visibility.corporate' }[tierCode] ??
    'visibility.b2c' // an unrecognised tier gets the most restrictive public view
  return { isActive: true, [field]: true }
}

async function tierContext(req) {
  const tierCode = await resolveTierCode(req.user)
  const tier = await CustomerTier.findOne({ code: tierCode }).lean()
  return { tierCode, tierIsPublic: tier?.isPublic !== false }
}

const listQuery = z
  .object({
    category: z.string().trim().min(1).max(120).optional(), // slug
    featured: z.enum(['true', 'false']).optional(),
    search: z.string().trim().min(2).max(80).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(60).default(24),
  })
  .strict()

publicProductsRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { category, featured, search, page, limit } = req.validatedQuery
    const { tierCode, tierIsPublic } = await tierContext(req)

    const filter = visibilityClause(tierCode)

    if (category) {
      const cat = await Category.findOne({ slug: category, isActive: true }).select('_id').lean()
      if (!cat) throw ApiError.notFound('Category not found')
      // Matches the category itself OR anything beneath it — one indexed query,
      // which is what the cached ancestors array on the product buys us.
      filter.$or = [{ categories: cat._id }, { categoryAncestors: cat._id }]
    }
    if (featured) filter.featured = featured === 'true'
    if (search) filter.$text = { $search: search }

    const [items, total] = await Promise.all([
      Product.find(filter)
        .select('name slug shortDescription images legacyImageUrl featured purchaseMode pricingModel pricing categories')
        .populate('categories', 'name slug')
        .sort(search ? { score: { $meta: 'textScore' } } : { featured: -1, order: 1, name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ])

    res.json({
      ok: true,
      data: items.map((p) => publicProductCard(p, { tierCode, tierIsPublic })),
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  }),
)

/**
 * Slug list for the build-time sitemap generator.
 * Kept separate and lean so the build never pages through the full catalogue.
 */
publicProductsRouter.get(
  '/slugs',
  asyncHandler(async (_req, res) => {
    const items = await Product.find({ isActive: true, 'visibility.b2c': true })
      .select('slug updatedAt')
      .sort({ slug: 1 })
      .lean()
    res.json({
      ok: true,
      data: items.map((p) => ({ slug: p.slug, updatedAt: p.updatedAt })),
      meta: { total: items.length },
    })
  }),
)

publicProductsRouter.get(
  '/:slug',
  validate({ params: z.object({ slug: z.string().trim().min(1).max(160) }).strict() }),
  asyncHandler(async (req, res) => {
    const { tierCode, tierIsPublic } = await tierContext(req)

    const product = await Product.findOne({
      slug: req.validatedParams.slug,
      ...visibilityClause(tierCode),
    })
      .populate('categories', 'name slug')
      .populate('primaryCategory', 'name slug')
      .lean()

    if (!product) throw ApiError.notFound('Product not found')

    // Resolve the option groups this product uses, in the product's own order.
    let optionGroups = []
    if (product.options?.length) {
      const ids = product.options.map((o) => o.optionGroup)
      const groups = await OptionGroup.find({ _id: { $in: ids }, isActive: true }).lean()
      const byId = new Map(groups.map((g) => [String(g._id), g]))
      optionGroups = product.options
        .map((po) => {
          const g = byId.get(String(po.optionGroup))
          return g ? publicOptionGroup(g, po) : null
        })
        .filter(Boolean)
        .sort((a, b) => a.order - b.order)
    }

    res.json({
      ok: true,
      data: publicProductDetail(product, { tierCode, tierIsPublic, optionGroups }),
    })
  }),
)
