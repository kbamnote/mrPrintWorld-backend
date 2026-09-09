import { Router } from 'express'
import { z } from 'zod'
import { Product } from '../../models/Product.js'
import { Category } from '../../models/Category.js'
import { OptionGroup } from '../../models/OptionGroup.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { resolveTierCode } from '../../services/pricing/resolvePrice.js'
import { buildVisibilityFilter } from '../../services/pricing/resolveOverride.js'
import { publicProductCard, publicProductDetail, publicOptionGroup } from '../../services/serializers.js'

export const publicProductsRouter = Router()

/**
 * Prices are visible to SIGNED-IN customers only.
 *
 * Anonymous visitors — and Google — get the full product page with no price;
 * the storefront shows a "View price" prompt instead. This is a deliberate
 * commercial choice: it costs price rich-results in search, and it is what
 * the client asked for.
 *
 * The gate is authentication, not tier: a signed-in retail customer sees
 * retail pricing, an approved trade customer sees theirs.
 */
async function tierContext(req) {
  const tierCode = await resolveTierCode(req.user)
  return { tierCode, showPrice: Boolean(req.user) }
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
    const { tierCode, showPrice } = await tierContext(req)

    // Query filter, never a response filter — includes per-organization
    // product access, so a restricted corporate account never even loads a
    // product it is not entitled to see.
    const filter = await buildVisibilityFilter(req.user)

    if (category) {
      const cat = await Category.findOne({ slug: category, isActive: true }).select('_id').lean()
      if (!cat) throw ApiError.notFound('Category not found')
      // Matches the category itself OR anything beneath it — one indexed query,
      // which is what the cached ancestors array on the product buys us.
      // An org allowlist may already own $or; combine with $and so one
      // cannot silently widen the other.
      const branch = [{ categories: cat._id }, { categoryAncestors: cat._id }]
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: branch }]
        delete filter.$or
      } else {
        filter.$or = branch
      }
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
      data: items.map((p) => publicProductCard(p, { tierCode, showPrice })),
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
    const { tierCode, showPrice } = await tierContext(req)

    const product = await Product.findOne({
      slug: req.validatedParams.slug,
      ...(await buildVisibilityFilter(req.user)),
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
      data: publicProductDetail(product, { tierCode, showPrice, optionGroups }),
    })
  }),
)
