/**
 * Phase 4 verification — organizations, product access and negotiated rates.
 *
 *   node scripts/testOrganizations.js
 *
 * Builds the brief's own worked example: standard corporate rate ₹170/sq.ft,
 * Ambuja negotiated to ₹158, Reliance to ₹162 — from ONE master product, with
 * no duplicated records. Then verifies the access allowlist actually hides
 * products at the query level.
 *
 * Creates throwaway data and deletes it.
 */

import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { User } from '../src/models/User.js'
import { Product } from '../src/models/Product.js'
import { Category } from '../src/models/Category.js'
import { Organization } from '../src/models/Organization.js'
import { PriceOverride } from '../src/models/PriceOverride.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  OK   ${name}`)
    passed += 1
  } catch (err) {
    console.log(`  FAIL ${name}\n         ${err.message}`)
    failed += 1
  }
}

const S = `org-${Date.now()}`
await connectDatabase()
const app = createApp()
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

const call = (method, path, body, token) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

// The suite owns its category, so it never depends on - or disturbs - the live catalogue.
const cat = (await Category.create({ name: `Test category ${S}`, slug: `test-cat-${S}` })).toObject()
const otherCat = (await Category.create({ name: `Test category two ${S}`, slug: `test-cat2-${S}` })).toObject()

// The ACP board from the brief: B2C 220, B2B 185, CORPORATE 170.
const acp = await Product.create({
  name: `ACP Board ${S}`,
  slug: `acp-board-${S}`,
  categories: [cat._id],
  primaryCategory: cat._id,
  categoryAncestors: cat.ancestors ?? [],
  pricingModel: 'AREA',
  purchaseMode: 'PRICE_AND_QUOTE',
  pricing: { unit: 'sqft', rates: { B2C: 220, B2B: 185, CORPORATE: 170 } },
  visibility: { b2c: true, b2b: true, corporate: true },
  isActive: true,
})

// A second product, in a DIFFERENT category, for the allowlist test.
const other = await Product.create({
  name: `Indoor Sign ${S}`,
  slug: `indoor-sign-${S}`,
  categories: [otherCat._id],
  primaryCategory: otherCat._id,
  categoryAncestors: otherCat.ancestors ?? [],
  pricingModel: 'AREA',
  purchaseMode: 'BUY_NOW',
  pricing: { unit: 'sqft', rates: { B2C: 180, B2B: 150, CORPORATE: 140 } },
  visibility: { b2c: true, b2b: true, corporate: true },
  isActive: true,
})

// Admin, for the management endpoints.
const admin = new User({ email: `${S}-admin@example.com`, name: 'Admin', role: 'ADMIN', isActive: true })
await admin.setPassword('admin-password-1234')
await admin.save()
const adminToken = await call('POST', '/api/admin/auth/login', {
  email: admin.email,
  password: 'admin-password-1234',
}).then(async (r) => (await r.json()).data.accessToken)

// Two corporate customers.
const ambuja = await Organization.create({
  name: `Ambuja ${S}`,
  slug: `ambuja-${S}`,
  tierCode: 'CORPORATE',
  status: 'ACTIVE',
})
const reliance = await Organization.create({
  name: `Reliance ${S}`,
  slug: `reliance-${S}`,
  tierCode: 'CORPORATE',
  status: 'ACTIVE',
})

async function makeMember(org, label) {
  const email = `${S}-${label}@example.com`
  const u = new User({
    email,
    name: `${label} Buyer`,
    role: 'CUSTOMER',
    accountType: 'CORPORATE',
    status: 'CORPORATE_APPROVED',
    resolvedTier: 'CORPORATE',
    organization: org._id,
    orgRole: 'PURCHASER',
    isActive: true,
  })
  await u.setPassword('member-password-123')
  await u.save()
  const token = await call('POST', '/api/auth/login', { email, password: 'member-password-123' }).then(
    async (r) => (await r.json()).data.accessToken,
  )
  return { user: u, token }
}

const ambujaBuyer = await makeMember(ambuja, 'ambuja')
const relianceBuyer = await makeMember(reliance, 'reliance')

const quote = async (token, slug = acp.slug) => {
  const res = await call('POST', '/api/public/pricing/calculate', { slug, width: 2, height: 5 }, token) // 10 sqft
  return (await res.json()).data
}

await test('standard corporate rate applies before any contract', async () => {
  const r = await quote(ambujaBuyer.token)
  assert.equal(r.tier, 'CORPORATE')
  assert.equal(r.total, 1700, '10 sqft x 170')
  assert.equal(r.negotiated, false)
})

await test('Ambuja negotiated rate of 158 applies to Ambuja only', async () => {
  const res = await call(
    'POST',
    '/api/admin/price-overrides',
    {
      scope: 'ORGANIZATION',
      scopeId: String(ambuja._id),
      product: String(acp._id),
      overrideType: 'ABSOLUTE',
      value: 158,
      note: 'Contract 2026',
    },
    adminToken,
  )
  assert.equal(res.status, 201, JSON.stringify(await res.json()))

  const r = await quote(ambujaBuyer.token)
  assert.equal(r.total, 1580, '10 sqft x 158')
  assert.equal(r.negotiated, true)
})

await test('...and Reliance is unaffected — one product, different contracts', async () => {
  const r = await quote(relianceBuyer.token)
  assert.equal(r.total, 1700, 'Reliance still pays the standard corporate rate')
  assert.equal(r.negotiated, false)
})

await test('Reliance gets its own rate of 162, still one master product', async () => {
  await call(
    'POST',
    '/api/admin/price-overrides',
    {
      scope: 'ORGANIZATION',
      scopeId: String(reliance._id),
      product: String(acp._id),
      overrideType: 'ABSOLUTE',
      value: 162,
    },
    adminToken,
  )
  assert.equal((await quote(relianceBuyer.token)).total, 1620)
  assert.equal((await quote(ambujaBuyer.token)).total, 1580, 'Ambuja unchanged')

  const count = await Product.countDocuments({ slug: acp.slug })
  assert.equal(count, 1, 'still exactly ONE product record')
})

await test('an anonymous visitor cannot see pricing, contracted or otherwise', async () => {
  // Pricing is gated behind sign-in, so no contract can leak to the public.
  const res = await call('POST', '/api/public/pricing/calculate', {
    slug: acp.slug, width: 2, height: 5,
  })
  assert.equal(res.status, 401)
})

await test('a category-wide override covers products added later', async () => {
  // 10% off everything in Outdoor Signage, for Reliance.
  await call(
    'POST',
    '/api/admin/price-overrides',
    {
      scope: 'ORGANIZATION',
      scopeId: String(reliance._id),
      category: String(cat._id),
      overrideType: 'PERCENT_OFF',
      value: 10,
      baseTier: 'CORPORATE',
    },
    adminToken,
  )
  // The product-specific 162 is MORE specific, so it still wins.
  assert.equal((await quote(relianceBuyer.token)).total, 1620, 'product override beats category override')

  // A brand-new product in that category picks the category rate up with no
  // further admin work — the point of category-level contracts.
  const fresh = await Product.create({
    name: `Fresh Board ${S}`,
    slug: `fresh-board-${S}`,
    categories: [cat._id],
    primaryCategory: cat._id,
    categoryAncestors: cat.ancestors ?? [],
    pricingModel: 'AREA',
    purchaseMode: 'BUY_NOW',
    pricing: { unit: 'sqft', rates: { B2C: 220, B2B: 185, CORPORATE: 170 } },
    visibility: { b2c: true, b2b: true, corporate: true },
    isActive: true,
  })
  const r = await quote(relianceBuyer.token, fresh.slug)
  assert.equal(r.total, 1530, '10 sqft x (170 - 10%) = 1530')
  assert.equal(r.negotiated, true)
})

await test('a personal override beats the organization contract', async () => {
  await call(
    'POST',
    '/api/admin/price-overrides',
    {
      scope: 'USER',
      scopeId: String(ambujaBuyer.user._id),
      product: String(acp._id),
      overrideType: 'ABSOLUTE',
      value: 150,
    },
    adminToken,
  )
  assert.equal((await quote(ambujaBuyer.token)).total, 1500, 'personal 150 beats org 158')
})

await test('an expired contract stops applying', async () => {
  const res = await call(
    'POST',
    '/api/admin/price-overrides',
    {
      scope: 'USER',
      scopeId: String(relianceBuyer.user._id),
      product: String(acp._id),
      overrideType: 'ABSOLUTE',
      value: 1,
      validFrom: '2020-01-01',
      validTo: '2020-12-31',
    },
    adminToken,
  )
  assert.equal(res.status, 201)
  // The window has passed, so the org rate still governs — NOT the ₹1 rate.
  assert.equal((await quote(relianceBuyer.token)).total, 1620)
})

await test('CATEGORY_ALLOWLIST hides products at the query level', async () => {
  await call(
    'PATCH',
    `/api/admin/organizations/${ambuja._id}`,
    { productAccessMode: 'CATEGORY_ALLOWLIST', allowedCategories: [String(cat._id)] },
    adminToken,
  )
  // Members were invalidated by the tier/access change, so sign in again.
  const token = await call('POST', '/api/auth/login', {
    email: `${S}-ambuja@example.com`,
    password: 'member-password-123',
  }).then(async (r) => (await r.json()).data.accessToken)

  const allowed = await call('GET', `/api/public/products/${acp.slug}`, null, token)
  assert.equal(allowed.status, 200, 'an allowed product stays visible')

  const denied = await call('GET', `/api/public/products/${other.slug}`, null, token)
  assert.equal(denied.status, 404, 'a product outside the allowlist must 404, not be filtered after loading')
})

await test('removing a member drops their contract pricing', async () => {
  const res = await call(
    'DELETE',
    `/api/admin/organizations/${ambuja._id}/members/${ambujaBuyer.user._id}`,
    null,
    adminToken,
  )
  const json = await res.json()
  assert.equal(res.status, 200, JSON.stringify(json))
  assert.equal(json.data.resolvedTier, 'B2C', 'leaving the org must not leave contract pricing behind')
})

/* Cleanup */
await PriceOverride.deleteMany({ scopeId: { $in: [ambuja._id, reliance._id, ambujaBuyer.user._id, relianceBuyer.user._id] } })
await Product.deleteMany({ slug: { $regex: S } })
await Category.deleteMany({ slug: { $regex: S } })
await User.deleteMany({ email: { $regex: S } })
await Organization.deleteMany({ slug: { $regex: S } })

server.close()
await disconnectDatabase()
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
