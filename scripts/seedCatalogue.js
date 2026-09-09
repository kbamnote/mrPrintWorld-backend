/**
 * Migrates the static catalogue into MongoDB.
 *
 *   npm run seed:catalogue           # dry run — reports, writes nothing
 *   npm run seed:catalogue -- --write
 *
 * Idempotent: matches on slug and updates in place, so re-running never
 * duplicates. Product slugs are copied VERBATIM — that is what makes this
 * migration invisible to Google.
 *
 * Reads products.js directly rather than parsing it, so the migrated data is
 * exactly what the website is serving today.
 */

import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { Category } from '../src/models/Category.js'
import { Product } from '../src/models/Product.js'
import { CATEGORY_TREE, PRODUCT_CATEGORY_MAP, PRODUCT_RENAMES } from '../src/data/taxonomy.js'

const WRITE = process.argv.includes('--write')

const FRONTEND_PRODUCTS = path.resolve(
  process.cwd(),
  '../mrPrintWorld-frontend/src/data/products.js',
)

async function loadStaticProducts() {
  const mod = await import(pathToFileURL(FRONTEND_PRODUCTS).href)
  if (!Array.isArray(mod.products)) throw new Error('products.js did not export an array')
  return mod.products
}

/** Create or update the category tree. Returns slug → _id. */
async function seedCategories() {
  const ids = new Map()
  let created = 0
  let updated = 0

  for (const [rootIndex, root] of CATEGORY_TREE.entries()) {
    let rootDoc = await Category.findOne({ slug: root.slug, parent: null })
    if (rootDoc) {
      rootDoc.name = root.name
      rootDoc.description = root.description
      rootDoc.order = rootIndex
      updated += 1
    } else {
      rootDoc = new Category({
        slug: root.slug,
        name: root.name,
        description: root.description,
        parent: null,
        order: rootIndex,
        isActive: true,
      })
      created += 1
    }
    if (WRITE) await rootDoc.save()
    ids.set(root.slug, rootDoc._id)

    for (const [childIndex, child] of (root.children ?? []).entries()) {
      let childDoc = await Category.findOne({ slug: child.slug, parent: rootDoc._id })
      if (childDoc) {
        childDoc.name = child.name
        childDoc.order = childIndex
        updated += 1
      } else {
        childDoc = new Category({
          slug: child.slug,
          name: child.name,
          parent: rootDoc._id,
          order: childIndex,
          isActive: true,
        })
        created += 1
      }
      if (WRITE) await childDoc.save()
      ids.set(child.slug, childDoc._id)
    }
  }

  return { ids, created, updated }
}

/** Parse "100 pieces" / "50 sets" into { qty, unit }. */
function parseMoq(raw) {
  if (!raw || typeof raw !== 'string') return { qty: null, unit: null }
  const m = raw.match(/^([\d,]+)\s*(.*)$/)
  if (!m) return { qty: null, unit: raw.trim() || null }
  return { qty: Number(m[1].replace(/,/g, '')), unit: m[2].trim() || 'pieces' }
}

async function seedProducts(categoryIds) {
  const statics = await loadStaticProducts()
  const report = { created: 0, updated: 0, renamed: [], unmapped: [], multiCategory: [] }

  for (const src of statics) {
    const catSlugs = PRODUCT_CATEGORY_MAP[src.slug]
    if (!catSlugs?.length) {
      report.unmapped.push(src.slug)
      continue
    }

    const catIds = catSlugs.map((s) => {
      const id = categoryIds.get(s)
      if (!id) throw new Error(`Product "${src.slug}" maps to unknown category "${s}"`)
      return id
    })
    if (catIds.length > 1) report.multiCategory.push(`${src.slug} → ${catSlugs.join(' + ')}`)

    const newName = PRODUCT_RENAMES[src.slug]
    if (newName && newName !== src.name) report.renamed.push(`${src.name} → ${newName}`)

    // Ancestors of every assigned category, deduplicated.
    const cats = await Category.find({ _id: { $in: catIds } }).select('ancestors').lean()
    const ancestors = [...new Set(cats.flatMap((c) => (c.ancestors ?? []).map(String)))]

    const fields = {
      name: newName ?? src.name,
      // slug is NOT touched — see the header note.
      categories: catIds,
      primaryCategory: catIds[0],
      categoryAncestors: ancestors,
      shortDescription: src.shortDescription ?? null,
      description: src.description ?? null,
      specifications: src.specifications ?? [],
      applications: src.applications ?? [],
      customization: src.customization ?? [],
      materials: src.materials ?? [],
      sizes: src.sizes ?? [],
      moq: parseMoq(src.moq),
      featured: Boolean(src.featured),
      // These 27 are already live and indexed, so they migrate ACTIVE — unlike
      // the new catalogue additions, which seed as drafts.
      isActive: true,
      // No pricing exists in the static data. Quote-only is the honest state;
      // it is also what the site does today (every product ends at "Enquire").
      pricingModel: 'QUOTE_ONLY',
      purchaseMode: 'QUOTE_ONLY',
      visibility: { b2c: true, b2b: true, corporate: true },
      seo: { title: src.seo?.title ?? null, description: src.seo?.description ?? null },
      // The hotlinked third-party image is preserved so nothing renders blank,
      // and its presence flags "needs a real photograph" in the admin list.
      legacyImageUrl: src.image ?? null,
    }

    const existing = await Product.findOne({ slug: src.slug })
    if (existing) {
      Object.assign(existing, fields)
      if (WRITE) await existing.save()
      report.updated += 1
    } else {
      const doc = new Product({ ...fields, slug: src.slug })
      if (WRITE) await doc.save()
      report.created += 1
    }
  }

  return { report, sourceCount: statics.length }
}

async function run() {
  await connectDatabase()
  console.log(WRITE ? '\nMODE: WRITE\n' : '\nMODE: DRY RUN — nothing will be written. Add --write to apply.\n')

  const cats = await seedCategories()
  console.log(`Categories: ${cats.created} created, ${cats.updated} updated (${cats.ids.size} total)`)

  const { report, sourceCount } = await seedProducts(cats.ids)
  console.log(`Products:   ${report.created} created, ${report.updated} updated (of ${sourceCount} in products.js)`)

  if (report.renamed.length) {
    console.log(`\nRenamed (slug preserved, so the URL is unchanged):`)
    report.renamed.forEach((r) => console.log(`  ${r}`))
  }
  if (report.multiCategory.length) {
    console.log(`\nIn multiple categories (the many-to-many case):`)
    report.multiCategory.forEach((r) => console.log(`  ${r}`))
  }
  if (report.unmapped.length) {
    console.log(`\n⚠  UNMAPPED — these would be LOST. Add them to PRODUCT_CATEGORY_MAP:`)
    report.unmapped.forEach((s) => console.log(`  ${s}`))
  }

  const handled = report.created + report.updated
  if (handled !== sourceCount) {
    console.log(`\n✗ MISMATCH: ${sourceCount} products in source, ${handled} handled. Nothing should be lost.`)
    await disconnectDatabase()
    process.exit(1)
  }
  console.log(`\n✓ All ${sourceCount} products accounted for.`)

  await disconnectDatabase()
}

run().catch(async (err) => {
  console.error(err)
  await disconnectDatabase().catch(() => {})
  process.exit(1)
})
