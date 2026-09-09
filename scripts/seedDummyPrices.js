/**
 * Applies PLACEHOLDER pricing so the three-tier engine can be exercised
 * before real rate cards exist.
 *
 *   npm run seed:prices            # dry run
 *   npm run seed:prices -- --write
 *   npm run seed:prices -- --clear --write   # revert everything to quote-only
 *
 * SAFETY: this script only ever touches products with isActive: false.
 *
 * The 27 migrated products are live on mrprintworld.com. Putting invented
 * numbers on those would show fabricated prices to real customers and invite
 * an order at the wrong rate. Drafts are invisible to the public API and the
 * sitemap, so placeholder pricing there is exercised only through the admin
 * preview — which is the point of the exercise.
 *
 * Tier shape is a consistent ratio, not a considered rate card:
 *   B2B       = B2C - 15%
 *   CORPORATE = B2C - 22%
 * Replace every one of these with real figures before publishing a product.
 */

import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { Category } from '../src/models/Category.js'
import { Product } from '../src/models/Product.js'

const WRITE = process.argv.includes('--write')
const CLEAR = process.argv.includes('--clear')

const tiers = (b2c) => ({
  B2C: b2c,
  B2B: Math.round(b2c * 0.85),
  CORPORATE: Math.round(b2c * 0.78),
})

/**
 * Pricing model per category, with an indicative B2C figure.
 * AREA suits anything sold by size; FIXED suits discrete units; SLAB suits
 * things genuinely bought in quantity; QUOTE_ONLY stays for project work.
 */
const BY_CATEGORY = {
  'outdoor-signage': { model: 'AREA', b2c: 220, unit: 'sqft', minArea: 10 },
  'indoor-signage': { model: 'AREA', b2c: 180, unit: 'sqft', minArea: 4 },
  'retail-signage': { model: 'AREA', b2c: 195, unit: 'sqft', minArea: 4 },
  'custom-signage': { model: 'AREA', b2c: 240, unit: 'sqft', minArea: 4 },
  'banners-displays': { model: 'AREA', b2c: 45, unit: 'sqft', minArea: 10 },
  'promotional-displays': { model: 'FIXED', b2c: 2500, unit: 'piece' },
  'event-advertising': { model: 'AREA', b2c: 65, unit: 'sqft', minArea: 20 },
}

/**
 * Per-product overrides, so the seeded catalogue demonstrates every pricing
 * model rather than only the two the category defaults produce.
 */
const OVERRIDES = {
  // Discrete units sold by the piece.
  // NB: the existing "Roll-Up Standees" product is slug `rollup-standees`
  // (no hyphen) and is LIVE, so it is excluded by the drafts-only boundary
  // regardless. It is not listed here to avoid implying otherwise.
  'table-top-standees': { model: 'FIXED', b2c: 850, unit: 'piece' },
  'event-standees': { model: 'FIXED', b2c: 1650, unit: 'piece' },
  'qr-code-stand': { model: 'FIXED', b2c: 320, unit: 'piece' },
  'menu-stand': { model: 'FIXED', b2c: 480, unit: 'piece' },
  'house-name-plates': { model: 'FIXED', b2c: 1800, unit: 'piece' },
  'room-name-plates': { model: 'FIXED', b2c: 650, unit: 'piece' },
  'acrylic-letters': { model: 'FIXED', b2c: 340, unit: 'letter' },

  // Genuinely bought in quantity — exercises the slab engine.
  'shelf-talkers': {
    model: 'SLAB',
    unit: 'piece',
    slabs: [
      { minQty: 100, maxQty: 499, b2c: 1400 },
      { minQty: 500, maxQty: 999, b2c: 5500 },
      { minQty: 1000, maxQty: null, b2c: 9500 },
    ],
  },
  'promotional-boards': {
    model: 'SLAB',
    unit: 'piece',
    slabs: [
      { minQty: 10, maxQty: 49, b2c: 4200 },
      { minQty: 50, maxQty: 199, b2c: 18000 },
      { minQty: 200, maxQty: null, b2c: 62000 },
    ],
  },

  // Project work: a single figure would be meaningless.
  'stall-branding': { model: 'QUOTE_ONLY' },
  'corporate-signage': { model: 'QUOTE_ONLY' },
  'industrial-signage': { model: 'QUOTE_ONLY' },
  'office-signage': { model: 'QUOTE_ONLY' },
  'retail-store-signage': { model: 'QUOTE_ONLY' },
  'society-signage': { model: 'QUOTE_ONLY' },
  'school-signage': { model: 'QUOTE_ONLY' },
  'hospital-signage': { model: 'QUOTE_ONLY' },
}

function buildPricing(spec) {
  if (spec.model === 'QUOTE_ONLY') {
    return { pricingModel: 'QUOTE_ONLY', purchaseMode: 'QUOTE_ONLY', pricing: null }
  }
  if (spec.model === 'FIXED') {
    return {
      pricingModel: 'FIXED',
      purchaseMode: 'PRICE_AND_QUOTE',
      pricing: { unit: spec.unit, amounts: tiers(spec.b2c) },
    }
  }
  if (spec.model === 'SLAB') {
    return {
      pricingModel: 'SLAB',
      purchaseMode: 'PRICE_AND_QUOTE',
      pricing: {
        unit: spec.unit,
        slabs: spec.slabs.map((s) => ({
          minQty: s.minQty,
          maxQty: s.maxQty,
          amounts: tiers(s.b2c),
        })),
      },
    }
  }
  return {
    pricingModel: 'AREA',
    purchaseMode: 'PRICE_AND_QUOTE',
    pricing: {
      unit: spec.unit,
      rates: tiers(spec.b2c),
      minChargeableArea: spec.minArea ?? null,
      roundUpTo: 0.5,
    },
  }
}

async function run() {
  await connectDatabase()
  console.log(WRITE ? '\nMODE: WRITE' : '\nMODE: DRY RUN — add --write to apply')
  console.log(CLEAR ? 'ACTION: clearing prices back to quote-only\n' : 'ACTION: applying placeholder prices\n')

  const cats = await Category.find().select('slug').lean()
  const slugById = new Map(cats.map((c) => [String(c._id), c.slug]))

  // The safety boundary: drafts only.
  const drafts = await Product.find({ isActive: false })
  console.log(`Draft products in scope: ${drafts.length}`)

  const live = await Product.countDocuments({ isActive: true })
  console.log(`Live products (untouched by design): ${live}\n`)

  const counts = { AREA: 0, FIXED: 0, SLAB: 0, QUOTE_ONLY: 0, skipped: 0 }

  for (const p of drafts) {
    if (CLEAR) {
      p.pricingModel = 'QUOTE_ONLY'
      p.purchaseMode = 'QUOTE_ONLY'
      p.pricing = null
      if (WRITE) await p.save()
      counts.QUOTE_ONLY += 1
      continue
    }

    const catSlugs = (p.categories ?? []).map((id) => slugById.get(String(id))).filter(Boolean)
    const spec = OVERRIDES[p.slug] ?? BY_CATEGORY[catSlugs[0]]
    if (!spec) {
      counts.skipped += 1
      continue
    }

    Object.assign(p, buildPricing(spec))
    if (WRITE) await p.save()
    counts[spec.model] += 1
  }

  console.log('Applied:')
  for (const [model, n] of Object.entries(counts)) {
    if (n) console.log(`  ${model.padEnd(12)} ${n}`)
  }

  if (!CLEAR) {
    console.log(
      '\n⚠  These are PLACEHOLDERS on unpublished drafts. No customer can see them.\n' +
        '   Replace with real figures before publishing any of these products.\n' +
        '   Revert at any time:  npm run seed:prices -- --clear --write\n',
    )
  }

  await disconnectDatabase()
}

run().catch(async (err) => {
  console.error(err)
  await disconnectDatabase().catch(() => {})
  process.exit(1)
})
