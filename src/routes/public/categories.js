import { Router } from 'express'
import { z } from 'zod'
import { Category } from '../../models/Category.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { publicCategory } from '../../services/serializers.js'

export const publicCategoriesRouter = Router()

/** Assemble a flat list into a nested tree in one pass. */
function buildTree(flat) {
  const nodes = new Map(flat.map((c) => [String(c._id), { ...c, children: [] }]))
  const roots = []
  for (const node of nodes.values()) {
    const parentId = node.parent ? String(node.parent) : null
    const parent = parentId ? nodes.get(parentId) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sortRec = (list) => {
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))
    list.forEach((n) => sortRec(n.children))
  }
  sortRec(roots)
  return roots
}

/** Full active tree. Small, stable, and cacheable — the nav is built from it. */
publicCategoriesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const flat = await Category.find({ isActive: true })
      .select('name slug parent depth order description image seo')
      .lean()

    res.set('Cache-Control', 'public, max-age=300')
    res.json({ ok: true, data: buildTree(flat).map(publicCategory) })
  }),
)

/** One category plus its breadcrumb trail — for the browse pages. */
publicCategoriesRouter.get(
  '/:slug',
  validate({ params: z.object({ slug: z.string().trim().min(1).max(120) }).strict() }),
  asyncHandler(async (req, res) => {
    const category = await Category.findOne({ slug: req.validatedParams.slug, isActive: true }).lean()
    if (!category) throw ApiError.notFound('Category not found')

    const [ancestors, children] = await Promise.all([
      Category.find({ _id: { $in: category.ancestors ?? [] } }).select('name slug').lean(),
      Category.find({ parent: category._id, isActive: true })
        .select('name slug order image')
        .sort({ order: 1, name: 1 })
        .lean(),
    ])

    // Order the trail root → parent; the $in query returns no guaranteed order.
    const byId = new Map(ancestors.map((a) => [String(a._id), a]))
    const trail = (category.ancestors ?? []).map((id) => byId.get(String(id))).filter(Boolean)

    res.json({
      ok: true,
      data: {
        ...publicCategory(category),
        breadcrumb: trail.map((a) => ({ id: String(a._id), name: a.name, slug: a.slug })),
        children: children.map(publicCategory),
      },
    })
  }),
)
