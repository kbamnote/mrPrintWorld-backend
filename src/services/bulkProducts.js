import slugify from 'slugify'
import { Product } from '../models/Product.js'
import { Category } from '../models/Category.js'
import { OptionGroup } from '../models/OptionGroup.js'
import { directImageLink, isOwnImage, importRemoteImage, removeImportedImages } from './remoteImage.js'

/**
 * Bulk create-or-update of products from the admin Excel upload.
 *
 * Rows arrive already read from the spreadsheet (the browser parses it). A
 * row whose name matches a product already in the category branch updates
 * that product — only the cells that were filled in; a blank cell leaves the
 * old value alone. Any other row creates a product, hidden until marked live.
 *
 * Photo links are ADDED to a product's photos (a link it already has is
 * skipped). Option fields, when a product has rows on the Options sheet,
 * REPLACE its fields — and must already exist in the field library.
 *
 * With dryRun nothing is written and no photo is copied: every row is still
 * built and validated, so the admin sees what will happen before importing.
 */

const TEXT_FIELDS = ['shortDescription', 'description', 'hsnCode', 'taxPercent']
const LIST_FIELDS = ['specifications', 'applications', 'customization', 'materials', 'sizes']
const MAX_IMAGES = 12 // the product form's limit

const nameKey = (name) => String(name).trim().toLowerCase().replace(/\s+/g, ' ')
const baseSlug = (name) => slugify(String(name), { lower: true, strict: true }) || 'product'
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const quantity = (key) => Number(key).toLocaleString('en-IN')

function messageOf(err) {
  if (err?.code === 11000) return 'Another product already uses this web address'
  if (err?.errors) return Object.values(err.errors).map((e) => e.message).join('; ')
  return err?.message ?? 'Could not save this product'
}

/** The pack keys ("500") a product is sold in. */
function packKeysOf(doc) {
  if (doc.pricingModel !== 'SLAB') return new Set()
  return new Set((doc.pricing?.slabs ?? []).filter((s) => s.maxQty === s.minQty).map((s) => String(s.minQty)))
}

/** What is wrong with a product's fields from the Options sheet, or null. */
function optionsProblem(options, packKeys, groupsById) {
  for (const o of options) {
    const group = groupsById.get(String(o.optionGroup))
    if (!group) return 'Options: a field is no longer in the field library'
    const codes = new Set((group.values ?? []).map((v) => v.code))
    const badChoice = (byChoice) => Object.keys(byChoice ?? {}).find((code) => !codes.has(code))
    const badPack = (byPack) => Object.keys(byPack ?? {}).find((pack) => !packKeys.has(pack))
    const packMessage = (pack) =>
      packKeys.size
        ? `${group.label}: ${quantity(pack)} is not one of this product's quantity packs`
        : `${group.label}: prices by pack need the product to be sold in quantity packs`
    const choiceMessage = (code) => `${group.label} has no choice "${code}"`

    let code = badChoice(o.valueOverrides)
    if (code) return choiceMessage(code)

    const pack = badPack(o.packOverrides) ?? badPack(o.packUnavailable)
    if (pack) return packMessage(pack)
    for (const byChoice of Object.values(o.packOverrides ?? {})) {
      code = badChoice(byChoice)
      if (code) return choiceMessage(code)
    }
    for (const blocked of Object.values(o.packUnavailable ?? {})) {
      code = blocked.find((c) => !codes.has(c))
      if (code) return choiceMessage(code)
    }

    if (o.driverPrices && Object.keys(o.driverPrices).length) {
      const driver = o.dependsOn ? groupsById.get(String(o.dependsOn)) : null
      if (!driver) return `${group.label}: prices for another field's choices need "Price depends on"`
      const driverCodes = new Set((driver.values ?? []).map((v) => v.code))
      for (const [driverCode, prices] of Object.entries(o.driverPrices)) {
        if (!driverCodes.has(driverCode)) return `${driver.label} has no choice "${driverCode}"`
        code = badChoice(prices.every)
        if (code) return choiceMessage(code)
        const driverPack = badPack(prices.packs)
        if (driverPack) return packMessage(driverPack)
        for (const byChoice of Object.values(prices.packs ?? {})) {
          code = badChoice(byChoice)
          if (code) return choiceMessage(code)
        }
      }
    }
  }
  return null
}

/**
 * @param {object}   args
 * @param {string}   args.categoryId  the category the upload was started from
 * @param {object[]} args.rows        validated rows (see routes/admin/products.js)
 * @param {boolean}  args.dryRun      check only: write nothing, copy no photos
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

  // Every library field any row mentions, in one query.
  const groupIds = [
    ...new Set(
      rows.flatMap((r) => (r.options ?? []).flatMap((o) => [o.optionGroup, o.dependsOn].filter(Boolean).map(String))),
    ),
  ]
  const groups = groupIds.length ? await OptionGroup.find({ _id: { $in: groupIds } }).select('label values').lean() : []
  const groupsById = new Map(groups.map((g) => [String(g._id), g]))

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

    // A product named only on the Options sheet must already exist.
    const optionsOnly = row.optionsOnly === true
    if (optionsOnly && !product) {
      fail('Not in this category yet — add it to the Products sheet first')
      continue
    }

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
    } else if (!hasSubcategories && !optionsOnly) {
      leafId = String(root._id)
    } else if (!product) {
      fail('Choose a subcategory')
      continue
    }

    const copied = [] // photos copied for this row, removed again if it fails
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

      // Fields from the Options sheet replace the product's fields. A field it
      // already had keeps its name on this product.
      if (row.options !== undefined) {
        const problem = optionsProblem(row.options, packKeysOf(doc), groupsById)
        if (problem) throw new Error(problem)
        const before = new Map((doc.options ?? []).map((o) => [String(o.optionGroup), o]))
        doc.options = row.options.map((o, i) => {
          const prev = before.get(String(o.optionGroup))
          return {
            ...o,
            order: i,
            labelOverride: prev?.labelOverride ?? null,
            ...(prev?.deltaOverrides?.size ? { deltaOverrides: prev.deltaOverrides } : {}),
          }
        })
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

      // Photo links to add: skip any the product already has, by stored link or original link.
      const known = new Set((doc.images ?? []).flatMap((img) => [img.url, img.sourceUrl]).filter(Boolean))
      const fresh = []
      for (const [i, link] of (row.images ?? []).entries()) {
        const direct = directImageLink(link)
        if (!direct) throw new Error(`Image ${i + 1} is not a web link`)
        if (known.has(link) || known.has(direct)) continue
        known.add(link)
        fresh.push({ link, position: i + 1 })
      }
      if ((doc.images?.length ?? 0) + fresh.length > MAX_IMAGES) {
        throw new Error(`A product can have up to ${MAX_IMAGES} photos — this would make ${(doc.images?.length ?? 0) + fresh.length}`)
      }

      await doc.validate()

      if (!dryRun) {
        const outcomes = await Promise.allSettled(
          fresh.map(({ link }) => (isOwnImage(link) ? { url: link } : importRemoteImage(link))),
        )
        outcomes.forEach((o) => o.status === 'fulfilled' && o.value.publicId && copied.push(o.value.publicId))
        const failedAt = outcomes.findIndex((o) => o.status === 'rejected')
        if (failedAt > -1) {
          throw new Error(`Image ${fresh[failedAt].position} ${outcomes[failedAt].reason.message}`)
        }

        const start = doc.images.length
        outcomes.forEach((o, i) => {
          doc.images.push({
            url: o.value.url,
            ...(o.value.publicId ? { publicId: o.value.publicId } : {}),
            ...(isOwnImage(fresh[i].link) ? {} : { sourceUrl: fresh[i].link }),
            alt: doc.name,
            order: start + i,
            isPrimary: start === 0 && i === 0,
          })
        })
        if (outcomes.length) doc.legacyImageUrl = null

        doc.updatedBy = userId
        await doc.save()
      }
      results.push({
        row: row.row,
        name: row.name,
        action: product ? 'update' : 'create',
        id: String(doc._id),
        newImages: fresh.length,
      })
    } catch (err) {
      await removeImportedImages(copied)
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
