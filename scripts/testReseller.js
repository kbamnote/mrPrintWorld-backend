/**
 * Reseller programme, phase R1.
 *
 *   node scripts/testReseller.js
 *
 * The claims being verified:
 *   - a signup through a share link belongs to that reseller; a bad code never blocks signup
 *   - with no markup the customer pays retail; with one, cost + markup
 *   - the customer never sees the reseller's cost or commission — in pricing, cart or order
 *   - the commission is recorded on the order, and ripens 7 days after delivery
 *   - a paused reseller's customers, and customers with their own trade price, pay normally
 *   - the dashboard is the reseller's alone, and shows no customer contact details
 */

import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { User } from '../src/models/User.js'
import { Product } from '../src/models/Product.js'
import { Category } from '../src/models/Category.js'
import { Order, nextOrderNumber } from '../src/models/Order.js'
import { ResellerPrice } from '../src/models/ResellerPrice.js'
import { priceCart } from '../src/services/cart.js'

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

const S = `rs-${Date.now()}`
const CODE = `T${String(Date.now()).slice(-8)}`
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
const json = async (res) => (await res.json()).data
const PASSWORD = 'customer-password-123'

// The suite owns its category, so it never depends on - or disturbs - the live catalogue.
const cat = (await Category.create({ name: `Test category ${S}`, slug: `test-cat-${S}` })).toObject()
const product = await Product.create({
  name: `Reseller Board ${S}`,
  slug: `reseller-board-${S}`,
  categories: [cat._id], primaryCategory: cat._id, categoryAncestors: cat.ancestors ?? [],
  pricingModel: 'AREA', purchaseMode: 'BUY_NOW',
  pricing: { unit: 'sqft', rates: { B2C: 200, B2B: 150, CORPORATE: 100 } },
  taxPercent: 18,
  visibility: { b2c: true, b2b: true, corporate: true }, isActive: true,
})
const board = { slug: product.slug, width: 2, height: 5 } // 10 sq.ft → retail 2000, reseller cost 1500

// An approved trade customer who is an active reseller.
const resellerUser = new User({
  email: `${S}-reseller@example.com`, name: 'Ravi Sharma', role: 'CUSTOMER',
  accountType: 'B2B', status: 'B2B_APPROVED', resolvedTier: 'B2B', isActive: true,
  reseller: { status: 'ACTIVE', code: CODE, storeName: 'Sharma Prints Test' },
})
await resellerUser.setPassword(PASSWORD)
await resellerUser.save()
const login = (email) =>
  call('POST', '/api/auth/login', { email, password: PASSWORD }).then(async (r) => (await r.json()).data.accessToken)
const resellerToken = await login(resellerUser.email)

let customerToken
let customerId
const customerEmail = `${S}-customer@example.com`
const calc = () => call('POST', '/api/public/pricing/calculate', board, customerToken).then(json)

/* ── Attribution ───────────────────────────────────────────────────────── */

await test('a share-link code resolves to the reseller’s store name', async () => {
  const res = await call('GET', `/api/public/resellers/${CODE.toLowerCase()}`)
  assert.equal(res.status, 200)
  assert.equal((await json(res)).storeName, 'Sharma Prints Test')
})

await test('signing up through the link makes the customer the reseller’s', async () => {
  const res = await call('POST', '/api/auth/register', {
    name: 'Priya Customer', email: customerEmail, password: PASSWORD, referralCode: CODE.toLowerCase(),
  })
  assert.equal(res.status, 201)
  const data = await json(res)
  assert.equal(data.user.soldBy?.storeName, 'Sharma Prints Test')
  customerToken = data.accessToken
  const saved = await User.findOne({ email: customerEmail }).lean()
  assert.equal(String(saved.referredBy), String(resellerUser._id))
  customerId = saved._id
})

await test('an unknown referral code does not block signup', async () => {
  const res = await call('POST', '/api/auth/register', {
    name: 'Stray Visitor', email: `${S}-stray@example.com`, password: PASSWORD, referralCode: 'NOPE999',
  })
  assert.equal(res.status, 201)
  const saved = await User.findOne({ email: `${S}-stray@example.com` }).lean()
  assert.equal(saved.referredBy, null)
})

/* ── Pricing ───────────────────────────────────────────────────────────── */

await test('with no markup set, the reseller’s customer pays our retail price', async () => {
  const data = await calc()
  assert.equal(data.total, 2000)
  assert.equal(data.soldBy, 'Sharma Prints Test')
})

await test('the customer’s price never reveals the reseller’s cost rate', async () => {
  const data = await calc()
  assert.equal(data.breakdown.length, 1, 'one summary line, not the itemised cost breakdown')
  assert.ok(!JSON.stringify(data).includes('150'), 'the ₹150/sq.ft trade rate must not appear anywhere')
})

await test('the reseller’s default markup prices on top of their cost', async () => {
  const res = await call('PATCH', '/api/reseller/settings', { defaultMarkupPercent: 50 }, resellerToken)
  assert.equal(res.status, 200)
  assert.equal((await calc()).total, 2250, '1500 cost + 50%')
})

await test('a per-product markup beats the default', async () => {
  const res = await call('PUT', `/api/reseller/products/${product._id}/markup`, { markupPercent: 10 }, resellerToken)
  assert.equal(res.status, 200)
  assert.equal((await calc()).total, 1650, '1500 cost + 10%')
})

await test('a price below the reseller’s cost is refused', async () => {
  const res = await call('PUT', `/api/reseller/products/${product._id}/markup`, { markupPercent: -5 }, resellerToken)
  assert.equal(res.status, 422)
})

await test('the reseller dashboard shows cost, customer price and earnings', async () => {
  const res = await call('GET', `/api/reseller/products?search=${encodeURIComponent(S)}`, null, resellerToken)
  const [row] = await json(res)
  assert.equal(row.costFrom, 150)
  assert.equal(row.sellFrom, 165)
  assert.equal(row.earnFrom, 15)
})

/* ── Quantity bands (visiting cards and the like) ──────────────────────── */

const cards = await Product.create({
  name: `Visiting Cards ${S}`,
  slug: `visiting-cards-${S}`,
  categories: [cat._id], primaryCategory: cat._id, categoryAncestors: cat.ancestors ?? [],
  pricingModel: 'SLAB', purchaseMode: 'BUY_NOW',
  pricing: {
    unit: 'pieces',
    slabs: [
      { minQty: 100, maxQty: 199, amounts: { B2C: 250, B2B: 200 } },
      { minQty: 200, maxQty: null, amounts: { B2C: 450, B2B: 360 } },
    ],
  },
  moq: { qty: 100, unit: 'pieces' },
  visibility: { b2c: true, b2b: true, corporate: true }, isActive: true,
})

await test('a slab-priced product offers its quantities, each with a price', async () => {
  const stray = await login(`${S}-stray@example.com`) // an ordinary retail customer
  const data = await call('POST', '/api/public/pricing/calculate', { slug: cards.slug, quantity: 100 }, stray).then(json)
  assert.deepEqual(
    data.quantityOptions.map((b) => [b.quantity, b.total, b.unitPrice]),
    [
      [100, 250, 2.5],
      [200, 450, 2.25],
    ],
    'retail bands, with the per-piece price the customer compares on',
  )
})

await test('a reseller’s customer sees the bands at the reseller’s prices', async () => {
  // Default markup is 50% on the reseller's own cost (200 and 360).
  const data = await call('POST', '/api/public/pricing/calculate', { slug: cards.slug, quantity: 100 }, customerToken).then(json)
  assert.deepEqual(
    data.quantityOptions.map((b) => [b.quantity, b.total]),
    [
      [100, 300],
      [200, 540],
    ],
  )
  assert.ok(!JSON.stringify(data.quantityOptions).includes('200,'), 'no reseller cost in the band list')
})

await test('a product priced by area has no quantity bands', async () => {
  const data = await calc()
  assert.deepEqual(data.quantityOptions, [])
})

/* ── Cart and order ────────────────────────────────────────────────────── */

await test('the cart shows the customer’s price but never the cost or commission', async () => {
  const res = await call('POST', '/api/cart/price', { lines: [{ ...board, quantity: 1 }] }, customerToken)
  const data = await json(res)
  assert.equal(data.subtotal, 1650)
  assert.equal(data.grandTotal, 1947, '1650 + 18% GST')
  assert.equal(data.soldBy, 'Sharma Prints Test')
  const raw = JSON.stringify(data)
  assert.ok(!raw.includes('resellerCost') && !raw.includes('commission'), 'no reseller economics in the response')
})

await test('the order records the reseller and the commission', async () => {
  const customer = await User.findById(customerId).lean()
  const priced = await priceCart([{ ...board, quantity: 1 }], customer)
  assert.equal(String(priced.reseller._id), String(resellerUser._id))
  assert.equal(priced.items[0].resellerCost, 1500)
  assert.equal(priced.items[0].commission, 150)
  assert.equal(priced.commissionTotal, 150, 'margin before GST')
})

let order
await test('the customer cannot see the commission on their own order', async () => {
  order = await Order.create({
    orderNumber: await nextOrderNumber(),
    user: customerId,
    customer: { name: 'Priya Customer', email: customerEmail },
    items: [{
      product: product._id, name: product.name, slug: product.slug, quantity: 1,
      unitPrice: 165, lineTotal: 1650, tierCode: 'B2C', taxPercent: 18, taxAmount: 297,
      resellerCost: 1500, commission: 150,
    }],
    subtotal: 1650, taxTotal: 297, grandTotal: 1947,
    shippingAddress: { name: 'Priya', phone: '9876543210', line1: '1 Road', city: 'Nagpur', state: 'MH', pincode: '440001' },
    status: 'PAID',
    payment: { status: 'PAID', paidAt: new Date() },
    reseller: resellerUser._id,
    resellerSnapshot: { name: 'Ravi Sharma', storeName: 'Sharma Prints Test', code: CODE },
    commissionTotal: 150,
  })
  const data = await json(await call('GET', `/api/orders/${order._id}`, null, customerToken))
  const raw = JSON.stringify(data)
  assert.ok(!raw.includes('resellerCost') && !raw.includes('commission'), 'no commission on the customer’s order')
  assert.equal(data.soldBy, 'Sharma Prints Test')
})

/* ── Dashboard ─────────────────────────────────────────────────────────── */

await test('the reseller sees their customer — name and city, no contact details', async () => {
  const data = await json(await call('GET', '/api/reseller/customers', null, resellerToken))
  const row = data.find((c) => c.id === String(customerId))
  assert.ok(row, 'the referred customer is listed')
  assert.equal(row.city, 'Nagpur')
  assert.equal(row.orders, 1)
  assert.ok(!('email' in row) && !('phone' in row), 'no email or phone')
})

await test('the reseller sees the order with its commission, pending until delivered', async () => {
  const data = await json(await call('GET', '/api/reseller/orders', null, resellerToken))
  assert.equal(data[0].commission, 150)
  assert.equal(data[0].commissionState, 'PENDING')
})

await test('commission is ready 7 days after delivery', async () => {
  await Order.updateOne({ _id: order._id }, { $set: { status: 'DELIVERED', deliveredAt: new Date(Date.now() - 8 * 86_400_000) } })
  const data = await json(await call('GET', '/api/reseller/orders', null, resellerToken))
  assert.equal(data[0].commissionState, 'READY')
  const me = await json(await call('GET', '/api/reseller/me', null, resellerToken))
  assert.equal(me.stats.commissionReady, 150)
  assert.equal(me.stats.customers, 1)
})

await test('a customer cannot open the reseller dashboard', async () => {
  const res = await call('GET', '/api/reseller/me', null, customerToken)
  assert.equal(res.status, 403)
})

/* ── Signing in from a store ───────────────────────────────────────────── */

async function makeExisting(label) {
  const u = new User({
    email: `${S}-${label}@example.com`, name: `Existing ${label}`, role: 'CUSTOMER',
    status: 'ACTIVE', resolvedTier: 'B2C', isActive: true,
  })
  await u.setPassword(PASSWORD)
  await u.save()
  return u
}

await test('an existing account with no orders that signs in from a store joins that reseller', async () => {
  const u = await makeExisting('newcomer')
  const res = await call('POST', '/api/auth/login', { email: u.email, password: PASSWORD, referralCode: CODE })
  assert.equal(res.status, 200)
  const data = await json(res)
  assert.equal(data.user.soldBy?.code, CODE, 'kept in the store after signing in')
  const saved = await User.findById(u._id).lean()
  assert.equal(String(saved.referredBy), String(resellerUser._id))
})

await test('an account that has already bought from us directly is NOT moved to a reseller', async () => {
  const u = await makeExisting('buyer')
  await Order.create({
    orderNumber: await nextOrderNumber(),
    user: u._id,
    customer: { name: u.name, email: u.email },
    items: [{ product: product._id, name: product.name, slug: product.slug, quantity: 1, unitPrice: 100, lineTotal: 100, tierCode: 'B2C' }],
    subtotal: 100, taxTotal: 0, grandTotal: 100,
    status: 'PAID', payment: { status: 'PAID', paidAt: new Date() },
  })
  const res = await call('POST', '/api/auth/login', { email: u.email, password: PASSWORD, referralCode: CODE })
  assert.equal(res.status, 200, 'sign-in itself still works')
  assert.equal((await json(res)).user.soldBy, null)
  const saved = await User.findById(u._id).lean()
  assert.equal(saved.referredBy, null, 'our own customer stays ours')
})

/* ── When reseller pricing stops ───────────────────────────────────────── */

await test('a paused reseller’s customers pay normal retail, with no "sold via"', async () => {
  await User.updateOne({ _id: resellerUser._id }, { $set: { 'reseller.status': 'PAUSED' } })
  const data = await calc()
  assert.equal(data.total, 2000)
  assert.equal(data.soldBy, undefined)
  await User.updateOne({ _id: resellerUser._id }, { $set: { 'reseller.status': 'ACTIVE' } })
})

await test('a referred customer approved for trade pays their own trade rate', async () => {
  await User.updateOne({ _id: customerId }, { $set: { resolvedTier: 'B2B' } })
  const data = await calc()
  assert.equal(data.total, 1500)
  assert.equal(data.soldBy, undefined)
})

/* Cleanup */
await Order.deleteMany({ reseller: resellerUser._id })
await Order.deleteMany({ 'customer.email': { $regex: S } })
await ResellerPrice.deleteMany({ reseller: resellerUser._id })
await Product.deleteMany({ slug: { $regex: S } })
await Category.deleteMany({ slug: { $regex: S } })
await User.deleteMany({ email: { $regex: S } })

server.close()
await disconnectDatabase()
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
