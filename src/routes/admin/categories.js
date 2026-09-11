import { Router } from 'express'
import { z } from 'zod'
import slugify from 'slugify'
import { Category } from '../../models/Category.js'
import { Product } from '../../models/Product.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { objectId } from '../../schemas/common.js'

export const adminCategoriesRouter = Router()

const categoryBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z.string().trim().min(1).max(120).optional(),
    parent: objectId.nullable().optional(),
    description: z.string().trim().max(2000).optional(),
    image: z
      .object({
        url: z.string().url(),
        publicId: z.string().optional(),
        alt: z.string().max(200).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    order: z.number().int().optional(),
    seo: z
      .object({
        title: z.string().trim().max(200).optional(),
        description: z.string().trim().max(400).optional(),
      })
      .strict()
      .optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

/** Flat list — the admin tree editor assembles it client-side. */
adminCategoriesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const items = await Category.find().sort({ depth: 1, order: 1, name: 1 }).lean()

    // Product counts per category, INCLUDING everything beneath it, so a root
    // shows what its whole branch holds. `liveCount` is what the storefront
    // uses to decide whether a category appears at all — a category with no
    // live products is kept off the website, and the admin needs to see why.
    const counts = await Product.aggregate([
      {
        $project: {
          isActive: 1,
          cats: {
            $setUnion: [{ $ifNull: ['$categories', []] }, { $ifNull: ['$categoryAncestors', []] }],
          },
        },
      },
      { $unwind: '$cats' },
      {
        $group: {
          _id: '$cats',
          count: { $sum: 1 },
          live: { $sum: { $cond: ['$isActive', 1, 0] } },
        },
      },
    ])
    const countBy = new Map(counts.map((c) => [String(c._id), c]))

    res.json({
      ok: true,
      data: items.map((c) => ({
        ...c,
        id: String(c._id),
        productCount: countBy.get(String(c._id))?.count ?? 0,
        liveCount: countBy.get(String(c._id))?.live ?? 0,
      })),
    })
  }),
)

adminCategoriesRouter.post(
  '/',
  validate({ body: categoryBody }),
  asyncHandler(async (req, res) => {
    const body = req.validatedBody
    const slug = slugify(body.slug ?? body.name, { lower: true, strict: true })
    const parent = body.parent ?? null

    if (parent && !(await Category.exists({ _id: parent }))) {
      throw ApiError.badRequest('Parent category not found')
    }

    // Say which name clashes, rather than the generic duplicate-key message.
    if (await Category.exists({ parent, slug })) {
      throw ApiError.conflict(`"${body.name}" already exists ${parent ? 'in this category' : 'as a category'}`)
    }

    // No sort-order field in the admin form: a new category goes to the end of
    // its siblings, which is where someone adding it expects to find it.
    if (body.order === undefined) {
      const last = await Category.findOne({ parent }).sort({ order: -1 }).select('order').lean()
      body.order = (last?.order ?? 0) + 1
    }

    const category = new Category({ ...body, parent, slug, createdBy: req.user._id })
    await category.save()

    res.status(201).json({ ok: true, data: category.toJSON() })
  }),
)

adminCategoriesRouter.patch(
  '/:id',
  validate({ params: z.object({ id: objectId }).strict(), body: categoryBody.partial() }),
  asyncHandler(async (req, res) => {
    const category = await Category.findById(req.validatedParams.id)
    if (!category) throw ApiError.notFound('Category not found')

    const body = req.validatedBody
    const parentChanged =
      body.parent !== undefined && String(body.parent ?? null) !== String(category.parent ?? null)

    if (parentChanged && String(body.parent) === String(category._id)) {
      throw ApiError.badRequest('A category cannot be its own parent')
    }

    Object.assign(category, body)
    if (body.slug || body.name) {
      category.slug = slugify(body.slug ?? body.name, { lower: true, strict: true })
    }

    await category.save() // pre-save recomputes this node's ancestry

    // Descendants are rebuilt explicitly — a hook doing it would fire an
    // unbounded cascade of writes inside someone else's save.
    if (parentChanged) {
      const updated = await Category.rebuildSubtree(category._id)
      await syncProductAncestors(category._id)
      return res.json({ ok: true, data: category.toJSON(), meta: { descendantsUpdated: updated } })
    }

    res.json({ ok: true, data: category.toJSON() })
  }),
)

adminCategoriesRouter.patch(
  '/reorder',
  validate({
    body: z
      .object({
        items: z.array(z.object({ id: objectId, order: z.number().int() }).strict()).min(1).max(500),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const ops = req.validatedBody.items.map((i) => ({
      updateOne: { filter: { _id: i.id }, update: { $set: { order: i.order } } },
    }))
    const result = await Category.bulkWrite(ops)
    res.json({ ok: true, data: { updated: result.modifiedCount } })
  }),
)

adminCategoriesRouter.delete(
  '/:id',
  validate({ params: z.object({ id: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    const id = req.validatedParams.id

    // Refuse rather than orphan. Deleting a category that still holds products
    // or children would leave dangling references that are invisible until a
    // page renders wrong.
    const [childCount, productCount] = await Promise.all([
      Category.countDocuments({ parent: id }),
      Product.countDocuments({ categories: id }),
    ])
    if (childCount > 0) {
      throw ApiError.conflict(`Category has ${childCount} subcategor${childCount === 1 ? 'y' : 'ies'}. Move or delete them first.`)
    }
    if (productCount > 0) {
      throw ApiError.conflict(`Category holds ${productCount} product(s). Reassign them first.`)
    }

    const deleted = await Category.findByIdAndDelete(id)
    if (!deleted) throw ApiError.notFound('Category not found')
    res.json({ ok: true, data: { id } })
  }),
)

/** Refresh the cached ancestor arrays on every product under a moved branch. */
async function syncProductAncestors(rootId) {
  const affected = await Category.find({ $or: [{ _id: rootId }, { ancestors: rootId }] })
    .select('_id ancestors')
    .lean()
  const ancestorsById = new Map(affected.map((c) => [String(c._id), c.ancestors ?? []]))

  const products = await Product.find({ categories: { $in: affected.map((c) => c._id) } })
    .select('categories')
    .lean()

  const ops = products.map((p) => {
    const union = new Set()
    for (const catId of p.categories ?? []) {
      for (const a of ancestorsById.get(String(catId)) ?? []) union.add(String(a))
    }
    return {
      updateOne: {
        filter: { _id: p._id },
        update: { $set: { categoryAncestors: [...union] } },
      },
    }
  })
  if (ops.length) await Product.bulkWrite(ops)
  return ops.length
}
