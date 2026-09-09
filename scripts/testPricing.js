/**
 * Pricing resolver checks — pure function, no database required.
 *
 *   node scripts/testPricing.js
 *
 * These cover the five pricing models and, more importantly, the failure modes
 * that must NOT happen: a missing tier price must never silently become a
 * cheaper tier's price, and it must never become zero.
 */

import assert from 'node:assert/strict'
import { calculatePrice, resolveDisplayPrice } from '../src/services/pricing/resolvePrice.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed += 1
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message}`)
    failed += 1
  }
}

/* ── FIXED ─────────────────────────────────────────────────────────────── */
const rollUpStandee = {
  slug: 'rollup-standees',
  pricingModel: 'FIXED',
  purchaseMode: 'BUY_NOW',
  pricing: { unit: 'piece', amounts: { B2C: 1450, B2B: 1225, CORPORATE: 1150 } },
}

test('FIXED — B2C single unit', () => {
  const r = calculatePrice({ product: rollUpStandee, tierCode: 'B2C', input: { quantity: 1 } })
  assert.equal(r.quotable, true)
  assert.equal(r.total, 1450)
})

test('FIXED — B2B is cheaper than B2C for the same input', () => {
  const b2c = calculatePrice({ product: rollUpStandee, tierCode: 'B2C', input: { quantity: 4 } })
  const b2b = calculatePrice({ product: rollUpStandee, tierCode: 'B2B', input: { quantity: 4 } })
  assert.equal(b2c.total, 5800)
  assert.equal(b2b.total, 4900)
  assert.ok(b2b.total < b2c.total)
})

test('FIXED — unknown tier falls back to QUOTE, never to a cheaper price', () => {
  const r = calculatePrice({ product: rollUpStandee, tierCode: 'DEALER', input: { quantity: 1 } })
  assert.equal(r.quotable, false)
  assert.equal(r.total, null)
  assert.match(r.reason, /No price configured/)
})

/* ── AREA — the ACP Sign Board example from the brief ──────────────────── */
const acpBoard = {
  slug: 'acp-sign-board',
  pricingModel: 'AREA',
  purchaseMode: 'PRICE_AND_QUOTE',
  pricing: {
    unit: 'sqft',
    rates: { B2C: 220, B2B: 185, CORPORATE: 170 },
    minChargeableArea: 10,
    roundUpTo: null,
  },
}

test('AREA — 4ft × 8ft at B2C ₹220/sqft = ₹7,040', () => {
  const r = calculatePrice({ product: acpBoard, tierCode: 'B2C', input: { width: 4, height: 8, quantity: 1 } })
  assert.equal(r.area, 32)
  assert.equal(r.total, 7040)
})

test('AREA — the three tiers differ exactly as configured', () => {
  const at = (tier) => calculatePrice({ product: acpBoard, tierCode: tier, input: { width: 4, height: 8 } }).total
  assert.equal(at('B2C'), 7040)
  assert.equal(at('B2B'), 5920)
  assert.equal(at('CORPORATE'), 5440)
})

test('AREA — minimum chargeable area is enforced', () => {
  // 1×2 = 2 sqft, below the 10 sqft minimum → charged as 10.
  const r = calculatePrice({ product: acpBoard, tierCode: 'B2C', input: { width: 1, height: 2 } })
  assert.equal(r.area, 10)
  assert.equal(r.total, 2200)
})

test('AREA — missing dimensions returns quote, not a zero price', () => {
  const r = calculatePrice({ product: acpBoard, tierCode: 'B2C', input: { quantity: 1 } })
  assert.equal(r.quotable, false)
  assert.equal(r.total, null)
})

test('AREA — PRICE_AND_QUOTE still flags requiresQuote alongside a price', () => {
  const r = calculatePrice({ product: acpBoard, tierCode: 'B2C', input: { width: 4, height: 8 } })
  assert.equal(r.quotable, true)
  assert.equal(r.requiresQuote, true)
})

/* ── SLAB — visiting cards ─────────────────────────────────────────────── */
const visitingCards = {
  slug: 'premium-business-cards',
  pricingModel: 'SLAB',
  purchaseMode: 'BUY_NOW',
  pricing: {
    unit: 'piece',
    slabs: [
      { minQty: 100, maxQty: 499, amounts: { B2C: 450, B2B: 380, CORPORATE: 350 } },
      { minQty: 500, maxQty: 999, amounts: { B2C: 1600, B2B: 1350, CORPORATE: 1250 } },
      { minQty: 1000, maxQty: null, amounts: { B2C: 2800, B2B: 2350, CORPORATE: 2200 } },
    ],
  },
}

test('SLAB — 250 qty lands in the 100–499 band', () => {
  const r = calculatePrice({ product: visitingCards, tierCode: 'B2C', input: { quantity: 250 } })
  assert.equal(r.total, 450)
})

test('SLAB — boundary at exactly 500 uses the middle band', () => {
  const r = calculatePrice({ product: visitingCards, tierCode: 'B2C', input: { quantity: 500 } })
  assert.equal(r.total, 1600)
})

test('SLAB — open-ended top band covers a very large order', () => {
  const r = calculatePrice({ product: visitingCards, tierCode: 'CORPORATE', input: { quantity: 50_000 } })
  assert.equal(r.total, 2200)
})

test('SLAB — quantity below the lowest band returns quote, not the lowest price', () => {
  const r = calculatePrice({ product: visitingCards, tierCode: 'B2C', input: { quantity: 50 } })
  assert.equal(r.quotable, false)
  assert.match(r.reason, /No price band/)
})

/* ── QUOTE_ONLY ────────────────────────────────────────────────────────── */
test('QUOTE_ONLY — never produces a number', () => {
  const r = calculatePrice({
    product: { slug: 'building-signage', pricingModel: 'QUOTE_ONLY', pricing: null },
    tierCode: 'B2C',
    input: { quantity: 1, width: 10, height: 10 },
  })
  assert.equal(r.quotable, false)
  assert.equal(r.total, null)
  assert.equal(r.requiresQuote, true)
})

/* ── OPTION deltas ─────────────────────────────────────────────────────── */
test('OPTION — FLAT delta adds once, PER_SQFT scales with area', () => {
  const r = calculatePrice({
    product: acpBoard,
    tierCode: 'B2C',
    input: {
      width: 4,
      height: 8,
      selections: [
        { label: 'Frame: Aluminium', deltaType: 'FLAT', priceDelta: { B2C: 500 } },
        { label: 'Lighting: Backlit', deltaType: 'PER_SQFT', priceDelta: { B2C: 60 } },
      ],
    },
  })
  // 32 sqft × 220 = 7040, + 500 flat, + (60 × 32 = 1920) = 9460
  assert.equal(r.total, 9460)
})

test('OPTION — PERCENT applies to the built-up line, not just the base', () => {
  const r = calculatePrice({
    product: acpBoard,
    tierCode: 'B2C',
    input: {
      width: 4,
      height: 8,
      selections: [
        { label: 'Frame', deltaType: 'FLAT', priceDelta: { B2C: 500 } },
        { label: 'Installation', deltaType: 'PERCENT', priceDelta: { B2C: 10 } },
      ],
    },
  })
  // (7040 + 500) × 1.10 = 8294
  assert.equal(r.total, 8294)
})

test('OPTION — a delta with no price for this tier is ignored, not treated as free money', () => {
  const r = calculatePrice({
    product: acpBoard,
    tierCode: 'CORPORATE',
    input: {
      width: 4,
      height: 8,
      selections: [{ label: 'Frame', deltaType: 'FLAT', priceDelta: { B2C: 500 } }], // no CORPORATE key
    },
  })
  assert.equal(r.total, 5440) // base only — the B2C delta is NOT borrowed
})

/* ── Display price ─────────────────────────────────────────────────────── */
test('display price — quote-only products return null', () => {
  assert.equal(resolveDisplayPrice({ product: { pricingModel: 'QUOTE_ONLY' }, tierCode: 'B2C' }), null)
})

test('display price — slab shows the cheapest band', () => {
  const d = resolveDisplayPrice({ product: visitingCards, tierCode: 'B2C' })
  assert.equal(d.from, 450)
})

test('display price — unknown tier yields null rather than another tier’s rate', () => {
  assert.equal(resolveDisplayPrice({ product: acpBoard, tierCode: 'DEALER' }), null)
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
