/**
 * The Phase 3 guarantee, tested against the real database.
 *
 *   node scripts/testCustomerTiers.js
 *
 * The claim being verified is narrow and important: selecting "B2B" during
 * registration must not, by any route, produce B2B pricing. Only an admin
 * approval can do that. Everything else here supports that claim.
 *
 * Creates throwaway accounts and a throwaway product, then deletes them.
 */

import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { User } from '../src/models/User.js'
import { Product } from '../src/models/Product.js'
import { Category } from '../src/models/Category.js'

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

const S = `tier-${Date.now()}`
await connectDatabase()
const app = createApp()
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

const call = (method, path, body, token) =>
  fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

// A priced, published product to quote against.
// The suite owns its category, so it never depends on - or disturbs - the live catalogue.
const cat = (await Category.create({ name: `Test category ${S}`, slug: `test-cat-${S}` })).toObject()
const product = await Product.create({
  name: `Tier Test Board ${S}`,
  slug: `tier-test-board-${S}`,
  categories: [cat._id],
  primaryCategory: cat._id,
  categoryAncestors: cat.ancestors ?? [],
  pricingModel: 'AREA',
  purchaseMode: 'PRICE_AND_QUOTE',
  pricing: { unit: 'sqft', rates: { B2C: 200, B2B: 150, CORPORATE: 100 } },
  visibility: { b2c: true, b2b: true, corporate: true },
  isActive: true,
})

const quote = async (token) => {
  const res = await call(
    'POST',
    '/api/public/pricing/calculate',
    { slug: product.slug, width: 2, height: 5 }, // 10 sqft
    token,
  )
  const json = await res.json()
  return json.data
}

let b2bToken
let b2bUserId

await test('anonymous visitor cannot see pricing at all', async () => {
  // Pricing is gated behind sign-in by product decision — an anonymous
  // caller gets 401, not a figure.
  const res = await call('POST', '/api/public/pricing/calculate', {
    slug: product.slug, width: 2, height: 5,
  })
  assert.equal(res.status, 401)
})

await test('registering as B2B does NOT grant B2B pricing', async () => {
  const res = await call('POST', '/api/auth/register', {
    name: 'Pending Trade',
    email: `${S}-b2b@example.com`,
    password: 'a-good-password-123',
    accountType: 'B2B',
    businessProfile: { businessName: 'Pending Traders Pvt Ltd', gstin: '27AAAAA0000A1Z5' },
  })
  const json = await res.json()
  assert.equal(res.status, 201, JSON.stringify(json))
  assert.equal(json.data.user.status, 'B2B_PENDING')
  assert.equal(json.data.user.tier.code, 'B2C', 'a pending applicant must still be on retail')
  b2bToken = json.data.accessToken
  b2bUserId = json.data.user.id
})

await test('...and their quotes come back at B2C, not B2B', async () => {
  const r = await quote(b2bToken)
  assert.equal(r.tier, 'B2C')
  assert.equal(r.total, 2000, 'must NOT be the 1500 a B2B customer would pay')
})

await test('a client cannot name a tier in the pricing request', async () => {
  const res = await call(
    'POST',
    '/api/public/pricing/calculate',
    { slug: product.slug, width: 2, height: 5, tier: 'CORPORATE' },
    b2bToken,
  )
  assert.equal(res.status, 422, 'the field does not exist and must be rejected')
})

await test('a client cannot self-grant a tier at registration', async () => {
  const res = await call('POST', '/api/auth/register', {
    name: 'Sneaky',
    email: `${S}-sneaky@example.com`,
    password: 'a-good-password-123',
    accountType: 'B2B',
    resolvedTier: 'CORPORATE', // the attack
    businessProfile: { businessName: 'Sneaky Ltd' },
  })
  assert.equal(res.status, 422, 'resolvedTier is not an accepted field')
})

await test('customer token cannot reach the admin surface', async () => {
  const res = await call('GET', '/api/admin/customers', null, b2bToken)
  assert.equal(res.status, 403, 'role check must reject a CUSTOMER token')
})

await test('admin approval is what changes the tier', async () => {
  // A throwaway admin, used only to perform the approval.
  const admin = new User({
    email: `${S}-admin@example.com`,
    name: 'Approver',
    role: 'ADMIN',
    isActive: true,
  })
  await admin.setPassword('admin-password-1234')
  await admin.save()

  const login = await call('POST', '/api/admin/auth/login', {
    email: admin.email,
    password: 'admin-password-1234',
  })
  const adminToken = (await login.json()).data.accessToken

  const res = await call('PATCH', `/api/admin/customers/${b2bUserId}/approve`, {}, adminToken)
  const json = await res.json()
  assert.equal(res.status, 200, JSON.stringify(json))
  assert.equal(json.data.resolvedTier, 'B2B')
  assert.equal(json.data.status, 'B2B_APPROVED')
})

await test('after approval the SAME customer is quoted at B2B', async () => {
  // Re-login: the old access token still carries the pre-approval tier, which
  // is correct — the change takes effect on the next token, not retroactively.
  const res = await call('POST', '/api/auth/login', {
    email: `${S}-b2b@example.com`,
    password: 'a-good-password-123',
  })
  const token = (await res.json()).data.accessToken
  const r = await quote(token)
  assert.equal(r.tier, 'B2B')
  assert.equal(r.total, 1500, '10 sqft x 150')
})

await test('a rejected applicant keeps working, at retail pricing', async () => {
  const reg = await call('POST', '/api/auth/register', {
    name: 'Rejected Co',
    email: `${S}-rej@example.com`,
    password: 'a-good-password-123',
    accountType: 'CORPORATE',
    businessProfile: { businessName: 'Rejected Co' },
  })
  const userId = (await reg.json()).data.user.id

  const login = await call('POST', '/api/admin/auth/login', {
    email: `${S}-admin@example.com`,
    password: 'admin-password-1234',
  })
  const adminToken = (await login.json()).data.accessToken

  const res = await call(
    'PATCH',
    `/api/admin/customers/${userId}/reject`,
    { reason: 'GSTIN could not be verified' },
    adminToken,
  )
  const json = await res.json()
  assert.equal(res.status, 200, JSON.stringify(json))
  assert.equal(json.data.resolvedTier, 'B2C', 'rejection must not lock the account out of buying')
})

/* Cleanup */
await Product.deleteOne({ _id: product._id })
await Category.deleteMany({ slug: { $regex: S } })
await User.deleteMany({ email: { $regex: S } })

server.close()
await disconnectDatabase()
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
