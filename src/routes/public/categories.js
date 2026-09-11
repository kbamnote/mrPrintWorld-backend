import { Router } from 'express'
import { z } from 'zod'
import { Category } from '../../models/Category.js'
import { Product } from '../../models/Product.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { buildVisibilityFilter } from '../../services/pricing/resolveOverride.js'
import { publicCategory } from '../../services/serializers.js'

export const publicCategoriesRouter = Router()

/**
 * Ids of every category holding at least one product THIS viewer can see —
 * directly, or anywhere beneath it.
 *
 * The storefront only lists categories that lead somewhere. An empty category
 * (just created, or whose products are all still drafts) stays out of the menu
 * until the admin publishes something into it, instead of appearing as a
 * button that opens "Nothing here yet".
 *
 * It uses the same visibility filter as the product list, so a corporate
 * account restricted to certain products never sees a category it would find
 * empty.
 */
async function populatedCategoryIds(user) {
  const filter = await buildVisibilityFilter(user)
  const [direct, ancestors] = await Promise.all([
    Product.distinct('categories', filter),
    Product.distinct('categoryAncestors', filter),
  ])
  return new Set([...direct, ...ancestors].map(String))
}

/**
 * Assemble a flat list into a nested tree in one pass.
 *
 * A node whose parent is missing from the list (hidden, or empty) is dropped
 * rather than promoted — otherwise hiding "Signage" would scatter its
 * subcategories across the top level of the menu.
 */
function buildTree(flat) {
  const nodes = new Map(flat.map((c) => [String(c._id), { ...c, children: [] }]))
  const roots = []
  for (const node of nodes.values()) {
    if (!node.parent) {
      roots.push(node)
      continue
    }
    nodes.get(String(node.parent))?.children.push(node)
  }
  const sortRec = (list) => {
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))
    list.forEach((n) => sortRec(n.children))
  }
  sortRec(roots)
  return roots
}

/**
 * The live tree the website's category menus are built from.
 *
 * `private, no-cache`: the answer depends on who is asking, and a category the
 * admin has just filled must show up on the next page load — not five minutes
 * later from a browser cache.
 */
publicCategoriesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const [flat, populated] = await Promise.all([
      Category.find({ isActive: true }).select('name slug parent depth order description image seo').lean(),
      populatedCategoryIds(req.user),
    ])

    res.set('Cache-Control', 'private, no-cache')
    res.json({
      ok: true,
      data: buildTree(flat.filter((c) => populated.has(String(c._id)))).map(publicCategory),
    })
  }),
)

/** One category plus its breadcrumb trail — for the browse pages. */
publicCategoriesRouter.get(
  '/:slug',
  validate({ params: z.object({ slug: z.string().trim().min(1).max(120) }).strict() }),
  asyncHandler(async (req, res) => {
    const category = await Category.findOne({ slug: req.validatedParams.slug, isActive: true }).lean()
    if (!category) throw ApiError.notFound('Category not found')

    const [ancestors, children, populated] = await Promise.all([
      Category.find({ _id: { $in: category.ancestors ?? [] } }).select('name slug').lean(),
      Category.find({ parent: category._id, isActive: true })
        .select('name slug order image')
        .sort({ order: 1, name: 1 })
        .lean(),
      populatedCategoryIds(req.user),
    ])

    // Order the trail root → parent; the $in query returns no guaranteed order.
    const byId = new Map(ancestors.map((a) => [String(a._id), a]))
    const trail = (category.ancestors ?? []).map((id) => byId.get(String(id))).filter(Boolean)

    res.set('Cache-Control', 'private, no-cache')
    res.json({
      ok: true,
      data: {
        ...publicCategory(category),
        breadcrumb: trail.map((a) => ({ id: String(a._id), name: a.name, slug: a.slug })),
        children: children.filter((c) => populated.has(String(c._id))).map(publicCategory),
      },
    })
  }),
)
