import slugify from 'slugify'
import { Product } from '../models/Product.js'
import { Category } from '../models/Category.js'

/**
 * Bulk create-or-update of products from the admin Excel upload.
 *
 * Rows arrive already read from the spreadsheet (the browser parses it). A
 * row whose name matches a product already in the category branch updates
 * that product — only the cells that were filled in; a blank cell leaves the
 * old value alone. Any other row creates a product, hidden until marked live.
 * Photos are added afterwards, from each product.
 *
 * With dryRun nothing is written: every row is still built and validated, so
 * the admin sees exactly what will happen, row by row, before importing.
 */

const TEXT_FIELDS = ['shortDescription', 'description', 'hsnCode', 'taxPercent']
const LIST_FIELDS = ['specifications', 'applications', 'customization', 'materials', 'sizes']

const nameKey = (name) => String(name).trim().toLowerCase().replace(/\s+/g, ' ')
const baseSlug = (name) => slugify(String(name), { lower: true, strict: true }) || 'product'
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function messageOf(err) {
  if (err?.code === 11000) return 'Another product already uses this web address'
  if (err?.errors) return Object.values(err.errors).map((e) => e.message).join('; ')
  return err?.message ?? 'Could not save this product'
}

/**
 * @param {object}   args
 * @param {string}   args.categoryId  the category the upload was started from
 * @param {object[]} args.rows        validated rows (see routes/admin/products.js)
 * @param {boolean}  args.dryRun      check only, write nothing
 * @returns {Promise<null | {dryRun, created, updated, failed, results}>} null when the category is gone
 */
export async function bulkUpsertProducts({ categoryId, rows, dryRun, userId }) {
  const root = await Category.findById(categoryId).select('name ancestors').lean()
  if (!root) return null

  const descendants = await Category.find({ ancestors: root._id }).select('name parent ancestors').lean()
  const branch = [root, ...descendants]
  const branchIds = new Set(branch.map((c) => String(c._id)))
  const parents = new Set(descendants.map((c) => String(c.parent)))
  // Products are filed in the deepest categories only.
  const leafIds = new Set(branch.filter((c) => !parents.has(String(c._id))).map((c) => String(c._id)))
  const hasSubcategories = descendants.length > 0

  // Category → its ancestors, for the cached categoryAncestors union.
  const ancestry = new Map(branch.map((c) => [String(c._id), (c.ancestors ?? []).map(String)]))
  async function ancestorsOf(ids) {
    const missing = ids.filter((id) => !ancestry.has(id))
    if (missing.length) {
      const found = await Category.find({ _id: { $in: missing } }).select('ancestors').lean()
      for (const c of found) ancestry.set(String(c._id), (c.ancestors ?? []).map(String))
    }
    return [...new Set(ids.flatMap((id) => ancestry.get(id) ?? []))]
  }

  const existing = await Product.find({ $or: [{ categories: root._id }, { categoryAncestors: root._id }] })
  const byName = new Map()
  for (const p of existing) {
    const k = nameKey(p.name)
    byName.set(k, [...(byName.get(k) ?? []), p])
  }

  // Web addresses for new products. Exact clashes in one query; only a base
  // that clashes is then checked for its -2, -3… variants.
  const taken = new Set()
  const bases = [...new Set(rows.filter((r) => !byName.has(nameKey(r.name))).map((r) => baseSlug(r.name)))]
  if (bases.length) {
    const clashing = await Product.find({ slug: { $in: bases } }).select('slug').lean()
    for (const { slug } of clashing) {
      taken.add(slug)
      const variants = await Product.find({ slug: { $regex: `^${escapeRegex(slug)}-\\d+$` } }).select('slug').lean()
      for (const v of variants) taken.add(v.slug)
    }
  }
  const freeSlug = (base) => {
    let slug = base
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`
    taken.add(slug)
    return slug
  }

  const results = []
  const seen = new Map() // name → first row using it

  for (const row of rows) {
    const fail = (message) => results.push({ row: row.row, name: row.name, action: 'error', message })
    const k = nameKey(row.name)

    if (seen.has(k)) {
      fail(`Same product name as row ${seen.get(k)}`)
      continue
    }
    seen.set(k, row.row)

    const matches = byName.get(k) ?? []
    if (matches.length > 1) {
      fail(`${matches.length} products in this category already have this name — change them in the admin panel`)
      continue
    }
    const product = matches[0] ?? null

    let leafId = null
    if (row.category) {
      if (!leafIds.has(row.category)) {
        fail(
          branchIds.has(row.category)
            ? 'That subcategory has subcategories inside it — choose one of those'
            : `That subcategory is not inside ${root.name}`,
        )
        continue
      }
      leafId = row.category
    } else if (!hasSubcategories) {
      leafId = String(root._id)
    } else if (!product) {
      fail('Choose a subcategory')
      continue
    }

    try {
      const doc = product ?? new Product({ slug: freeSlug(baseSlug(row.name)), createdBy: userId })
      doc.name = row.name

      for (const field of TEXT_FIELDS) if (row[field] !== undefined) doc.set(field, row[field])
      for (const field of LIST_FIELDS) if (row[field] !== undefined) doc.set(field, row[field])
      if (row.isActive !== undefined) doc.isActive = row.isActive
      if (row.seoTitle !== undefined) doc.set('seo.title', row.seoTitle)
      if (row.seoDescription !== undefined) doc.set('seo.description', row.seoDescription)
      if (row.unit !== undefined) doc.set('pricing.unit', row.unit)

      // Quantity packs replace the product's pricing; no pack cells leave it as it was.
      if (row.packs?.length) {
        doc.pricingModel = 'SLAB'
        if (!product || doc.purchaseMode === 'QUOTE_ONLY') doc.purchaseMode = 'BUY_NOW'
        doc.set('pricing.amounts', undefined)
        doc.set('pricing.rates', undefined)
        doc.set(
          'pricing.slabs',
          [...row.packs]
            .sort((a, b) => a.qty - b.qty)
            .map((pack) => ({ minQty: pack.qty, maxQty: pack.qty, amounts: pack.amounts })),
        )
      }

      // Filing: a new product goes in its subcategory. An existing one moves
      // only within this branch — categories elsewhere are kept.
      const current = (doc.categories ?? []).map(String)
      if (leafId && !current.includes(leafId)) {
        const categories = [...current.filter((id) => !branchIds.has(id)), leafId]
        const primary = doc.primaryCategory ? String(doc.primaryCategory) : null
        doc.categories = categories
        doc.primaryCategory = primary && !branchIds.has(primary) && categories.includes(primary) ? primary : leafId
        doc.categoryAncestors = await ancestorsOf(categories)
      }

      if (dryRun) {
        await doc.validate()
      } else {
        doc.updatedBy = userId
        await doc.save()
      }
      results.push({ row: row.row, name: row.name, action: product ? 'update' : 'create', id: String(doc._id) })
    } catch (err) {
      fail(messageOf(err))
    }
  }

  return {
    dryRun,
    created: results.filter((r) => r.action === 'create').length,
    updated: results.filter((r) => r.action === 'update').length,
    failed: results.filter((r) => r.action === 'error').length,
    results,
  }
}
