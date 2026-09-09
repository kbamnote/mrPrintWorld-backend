/**
 * End-to-end check against the real database.
 *
 *   node scripts/testIntegration.js
 *
 * Creates a throwaway category + product, exercises admin and public routes,
 * then deletes everything it made. Safe to re-run.
 */

import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { Category } from '../src/models/Category.js'
import { Product } from '../src/models/Product.js'
import { User } from '../src/models/User.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed += 1
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message}`)
    failed += 1
  }
}

const SUFFIX = `itest-${Date.now()}`

await connectDatabase()
const app = createApp()
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

let token = null
const req = (method, path, body, auth = true) =>
  fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

// A known password on a temporary admin, so the test never depends on the
// real account's credentials.
const tmpEmail = `${SUFFIX}@example.com`
const tmpUser = new User({ email: tmpEmail, name: 'Integration Test', role: 'ADMIN', isActive: true })
await tmpUser.setPassword('integration-test-password-123')
await tmpUser.save()

let rootId, childId, productId

await test('admin login returns an access token', async () => {
  const res = await req('POST', '/api/admin/auth/login', {
    email: tmpEmail,
    password: 'integration-test-password-123',
  }, false)
  const json = await res.json()
  assert.equal(res.status, 200, JSON.stringify(json))
  assert.ok(json.data.accessToken)
  token = json.data.accessToken
})

await test('login with a wrong password is rejected', async () => {
  const res = await req('POST', '/api/admin/auth/login', { email: tmpEmail, password: 'wrong' }, false)
  assert.equal(res.status, 401)
})

await test('create a root category', async () => {
  const res = await req('POST', '/api/admin/categories', { name: `Signage ${SUFFIX}` })
  const json = await res.json()
  assert.equal(res.status, 201, JSON.stringify(json))
  assert.equal(json.data.depth, 0)
  assert.deepEqual(json.data.ancestors, [])
  rootId = json.data._id ?? json.data.id
})

await test('create a child category — ancestry is maintained automatically', async () => {
  const res = await req('POST', '/api/admin/categories', { name: `Outdoor ${SUFFIX}`, parent: rootId })
  const json = await res.json()
  assert.equal(res.status, 201, JSON.stringify(json))
  assert.equal(json.data.depth, 1)
  assert.equal(String(json.data.ancestors[0]), String(rootId))
  childId = json.data._id ?? json.data.id
})

await test('create a product with real tier pricing (the ACP example)', async () => {
  const res = await req('POST', '/api/admin/products', {
    name: `ACP Sign Board ${SUFFIX}`,
    categories: [childId],
    shortDescription: 'Integration test product',
    pricingModel: 'AREA',
    purchaseMode: 'PRICE_AND_QUOTE',
    pricing: {
      unit: 'sqft',
      rates: { B2C: 220, B2B: 185, CORPORATE: 170 },
      minChargeableArea: 10,
    },
    visibility: { b2c: true, b2b: true, corporate: true },
    isActive: true,
  })
  const json = await res.json()
  assert.equal(res.status, 201, JSON.stringify(json))
  productId = json.data._id ?? json.data.id
  // categoryAncestors cached from the category tree
  assert.ok(json.data.categoryAncestors.some((a) => String(a) === String(rootId)))
})

await test('unknown tier code in pricing is rejected', async () => {
  const res = await req('POST', '/api/admin/products', {
    name: `Bad tier ${SUFFIX}`,
    categories: [childId],
    pricingModel: 'FIXED',
    pricing: { unit: 'piece', amounts: { DEALER: 100 } },
  })
  const json = await res.json()
  assert.equal(res.status, 422, JSON.stringify(json))
  assert.match(JSON.stringify(json.error), /DEALER/)
})

await test('admin price preview matches the resolver', async () => {
  const res = await req('POST', `/api/admin/products/${productId}/preview-price`, {
    tier: 'B2C',
    quantity: 1,
    width: 4,
    height: 8,
  })
  const json = await res.json()
  assert.equal(res.status, 200, JSON.stringify(json))
  assert.equal(json.data.total, 7040)
})

/* ── Public surface, anonymous ─────────────────────────────────────────── */

await test('PUBLIC: anonymous listing shows the product with B2C price', async () => {
  const res = await fetch(`${base}/api/public/products?category=outdoor-${SUFFIX}`)
  const json = await res.json()
  assert.equal(res.status, 200, JSON.stringify(json))
  const found = json.data.find((p) => String(p.id) === String(productId))
  assert.ok(found, 'product should be listed')
  assert.equal(found.price.from, 220, 'B2C rate is public')
})

await test('PUBLIC: detail page never exposes the raw tier rate table', async () => {
  const slug = `acp-sign-board-${SUFFIX}`
  const res = await fetch(`${base}/api/public/products/${slug}`)
  const json = await res.json()
  assert.equal(res.status, 200, JSON.stringify(json))
  const body = JSON.stringify(json)
  assert.ok(!body.includes('185'), 'B2B rate must not appear in a public response')
  assert.ok(!body.includes('170'), 'CORPORATE rate must not appear in a public response')
  assert.ok(body.includes('220'), 'B2C rate should appear')
})

await test('PUBLIC: pricing endpoint computes the same number as admin preview', async () => {
  const res = await fetch(`${base}/api/public/pricing/calculate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: `acp-sign-board-${SUFFIX}`, quantity: 1, width: 4, height: 8 }),
  })
  const json = await res.json()
  assert.equal(res.status, 200, JSON.stringify(json))
  assert.equal(json.data.total, 7040, 'admin and customer must never disagree')
  assert.equal(json.data.tier, 'B2C', 'anonymous resolves to the default tier')
})

await test('PUBLIC: an inactive product disappears from the public API', async () => {
  await req('PATCH', `/api/admin/products/${productId}`, { isActive: false })
  const res = await fetch(`${base}/api/public/products/acp-sign-board-${SUFFIX}`)
  assert.equal(res.status, 404, 'draft products must not be publicly reachable')
  await req('PATCH', `/api/admin/products/${productId}`, { isActive: true })
})

await test('PUBLIC: a product hidden from B2C is not visible anonymously', async () => {
  await req('PATCH', `/api/admin/products/${productId}`, { visibility: { b2c: false } })
  const res = await fetch(`${base}/api/public/products/acp-sign-board-${SUFFIX}`)
  assert.equal(res.status, 404, 'visibility must filter the query, not the response')
  await req('PATCH', `/api/admin/products/${productId}`, { visibility: { b2c: true } })
})

await test('category delete is refused while it still holds products', async () => {
  const res = await req('DELETE', `/api/admin/categories/${childId}`)
  const json = await res.json()
  assert.equal(res.status, 409, JSON.stringify(json))
  assert.match(json.error.message, /product/i)
})

/* ── Cleanup ───────────────────────────────────────────────────────────── */
await Product.deleteMany({ name: { $regex: SUFFIX } })
await Category.deleteMany({ name: { $regex: SUFFIX } })
await User.deleteOne({ email: tmpEmail })

server.close()
await disconnectDatabase()
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
