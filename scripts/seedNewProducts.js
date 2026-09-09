/**
 * Seeds the client-supplied Signage and Advertising catalogue.
 *
 *   npm run seed:new            # dry run
 *   npm run seed:new -- --write
 *
 * Everything created here is a DRAFT (isActive: false, QUOTE_ONLY): present in
 * the admin panel, absent from the public API and the sitemap. Publishing ~60
 * empty product pages at once would put thin content on a domain whose
 * existing pages already rank.
 *
 * Idempotent — matches on slug and updates in place.
 */

import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { Category } from '../src/models/Category.js'
import { Product } from '../src/models/Product.js'
import { NEW_PRODUCTS, SPLIT_RENAMES } from '../src/data/newProducts.js'

const WRITE = process.argv.includes('--write')

async function categoryIdMap() {
  const cats = await Category.find().select('slug ancestors').lean()
  return new Map(cats.map((c) => [c.slug, c]))
}

async function run() {
  await connectDatabase()
  console.log(WRITE ? '\nMODE: WRITE\n' : '\nMODE: DRY RUN — add --write to apply.\n')

  const cats = await categoryIdMap()
  const report = { created: 0, updated: 0, renamed: 0, multi: [], missingCategory: [], slugClash: [] }

  /* ── 1. Apply the splits/renames to existing indexed products ───────── */
  for (const [slug, patch] of Object.entries(SPLIT_RENAMES)) {
    const existing = await Product.findOne({ slug })
    if (!existing) {
      console.log(`  ⚠  ${slug} not found — skipping rename`)
      continue
    }
    const catDocs = patch.categories.map((s) => cats.get(s)).filter(Boolean)
    if (catDocs.length !== patch.categories.length) {
      report.missingCategory.push(`${slug} → ${patch.categories.join(', ')}`)
      continue
    }
    existing.name = patch.name
    existing.shortDescription = patch.shortDescription
    existing.description = patch.description
    existing.categories = catDocs.map((c) => c._id)
    existing.primaryCategory = catDocs[0]._id
    existing.categoryAncestors = [
      ...new Set(catDocs.flatMap((c) => (c.ancestors ?? []).map(String))),
    ]
    if (WRITE) await existing.save()
    report.renamed += 1
    console.log(`  renamed  ${slug} → "${patch.name}" (URL unchanged)`)
  }

  /* ── 2. Create the new catalogue as drafts ──────────────────────────── */
  for (const src of NEW_PRODUCTS) {
    const catDocs = src.categories.map((s) => cats.get(s)).filter(Boolean)
    if (catDocs.length !== src.categories.length) {
      report.missingCategory.push(`${src.slug} → ${src.categories.join(', ')}`)
      continue
    }
    if (catDocs.length > 1) report.multi.push(`${src.slug} → ${src.categories.join(' + ')}`)

    const fields = {
      name: src.name,
      categories: catDocs.map((c) => c._id),
      primaryCategory: catDocs[0]._id,
      categoryAncestors: [...new Set(catDocs.flatMap((c) => (c.ancestors ?? []).map(String)))],
      shortDescription: src.shortDescription,
      description: src.description,
      // Drafts. No price, no photo, not public, not in the sitemap.
      isActive: false,
      pricingModel: 'QUOTE_ONLY',
      purchaseMode: 'QUOTE_ONLY',
      visibility: { b2c: true, b2b: true, corporate: true },
      seo: { title: `${src.name} | MRPrint World`, description: src.shortDescription },
      // Specifications, sizes, materials and MOQ are deliberately NOT set —
      // they are commercial claims and must come from the team.
    }

    const existing = await Product.findOne({ slug: src.slug })
    if (existing) {
      // Never resurrect a product the team has already published and edited:
      // only refresh copy, leave status and pricing alone.
      existing.name = fields.name
      existing.shortDescription = fields.shortDescription
      existing.description = fields.description
      existing.categories = fields.categories
      existing.primaryCategory = fields.primaryCategory
      existing.categoryAncestors = fields.categoryAncestors
      if (WRITE) await existing.save()
      report.updated += 1
    } else {
      if (WRITE) await new Product({ ...fields, slug: src.slug }).save()
      report.created += 1
    }
  }

  console.log(`\nNew products: ${report.created} created, ${report.updated} updated`)
  console.log(`Renames/splits applied: ${report.renamed}`)

  if (report.multi.length) {
    console.log(`\nIn multiple categories (one record, one URL):`)
    report.multi.forEach((m) => console.log(`  ${m}`))
  }
  if (report.missingCategory.length) {
    console.log(`\n✗ MISSING CATEGORIES — these were skipped:`)
    report.missingCategory.forEach((m) => console.log(`  ${m}`))
    await disconnectDatabase()
    process.exit(1)
  }

  const total = await Product.countDocuments()
  const live = await Product.countDocuments({ isActive: true })
  console.log(`\nCatalogue now: ${total} products (${live} live, ${total - live} drafts)`)

  await disconnectDatabase()
}

run().catch(async (err) => {
  console.error(err)
  await disconnectDatabase().catch(() => {})
  process.exit(1)
})
