import mongoose from 'mongoose'

/**
 * Category — a self-referencing tree.
 *
 * Deliberately ONE collection rather than separate `categories` and
 * `subcategories`. Two collections give exactly two levels forever, need a
 * join for every breadcrumb, and require a migration the first time someone
 * wants Signage → Outdoor → Channel Letters → LED Channel Letters.
 *
 * `ancestors` is the materialised-path trick: every ancestor id is cached on
 * the document, so "every product under Signage" is one indexed query instead
 * of a recursive walk. It is maintained in the pre-save hook below — never set
 * it by hand.
 */
const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },

    // Unique within a parent, not globally: "Custom Signage" and a future
    // "Custom Printing" can both own a `custom` child without colliding.
    slug: { type: String, required: true, trim: true, lowercase: true, index: true },

    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
      index: true,
    },

    /** Root → … → immediate parent. Maintained automatically. */
    ancestors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category', index: true }],

    /** 0 for a root. Derived from ancestors.length. */
    depth: { type: Number, default: 0, index: true },

    description: { type: String, trim: true, maxlength: 2000 },
    image: {
      url: { type: String, trim: true },
      publicId: { type: String, trim: true },
      alt: { type: String, trim: true },
    },

    /** Manual sort within siblings. Lower shows first. */
    order: { type: Number, default: 0 },

    seo: {
      title: { type: String, trim: true, maxlength: 200 },
      description: { type: String, trim: true, maxlength: 400 },
    },

    isActive: { type: Boolean, default: true, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
)

// A slug is unique among its siblings. `parent: null` participates, so two
// roots cannot share a slug either.
categorySchema.index({ parent: 1, slug: 1 }, { unique: true })
categorySchema.index({ parent: 1, order: 1 })

categorySchema.virtual('children', {
  ref: 'Category',
  localField: '_id',
  foreignField: 'parent',
})

/**
 * Keep `ancestors` and `depth` correct whenever the parent changes.
 *
 * Note this handles the document being re-parented, but NOT the descendants of
 * a moved node — those are rebuilt explicitly by the admin route via
 * `rebuildSubtree()`, because doing it in a hook would fire an unbounded
 * cascade of writes inside someone else's save.
 */
categorySchema.pre('save', async function assignAncestry(next) {
  if (!this.isModified('parent')) return next()

  if (!this.parent) {
    this.ancestors = []
    this.depth = 0
    return next()
  }

  const parent = await this.constructor.findById(this.parent).select('ancestors').lean()
  if (!parent) return next(new Error('Parent category not found'))

  // Guard against a cycle: a node may never be its own ancestor.
  if (parent.ancestors?.some((id) => id.equals(this._id))) {
    return next(new Error('Cannot move a category beneath its own descendant'))
  }

  this.ancestors = [...(parent.ancestors ?? []), this.parent]
  this.depth = this.ancestors.length
  next()
})

/**
 * Recompute ancestry for every descendant of a node. Call after re-parenting.
 * Returns the number of documents updated.
 */
categorySchema.statics.rebuildSubtree = async function rebuildSubtree(rootId) {
  const root = await this.findById(rootId).select('ancestors').lean()
  if (!root) return 0

  const descendants = await this.find({ ancestors: rootId }).select('_id parent').lean()
  if (!descendants.length) return 0

  // Walk breadth-first from the root so each parent's ancestry is settled
  // before its children are computed.
  const byParent = new Map()
  for (const d of descendants) {
    const key = String(d.parent)
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key).push(d._id)
  }

  const ops = []
  const queue = [{ id: rootId, ancestors: [...(root.ancestors ?? []), rootId] }]

  while (queue.length) {
    const { id, ancestors } = queue.shift()
    for (const childId of byParent.get(String(id)) ?? []) {
      ops.push({
        updateOne: {
          filter: { _id: childId },
          update: { $set: { ancestors, depth: ancestors.length } },
        },
      })
      queue.push({ id: childId, ancestors: [...ancestors, childId] })
    }
  }

  if (ops.length) await this.bulkWrite(ops)
  return ops.length
}

export const Category = mongoose.model('Category', categorySchema)
