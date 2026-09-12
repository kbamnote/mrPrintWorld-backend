/**
 * Checkout and payment verification — the money path.
 *
 *   node scripts/testCheckout.js
 *
 * The claims being verified:
 *   - a client cannot name its own price, at any point in the flow
 *   - an order is never marked paid without a valid HMAC signature
 *   - a signature from one order cannot be replayed against another
 *   - one customer cannot read another's order
 *   - quote-only products cannot be bought online
 *
 * Runs without Razorpay credentials: everything up to and including signature
 * verification is local, so the security properties are testable offline.
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { User } from '../src/models/User.js'
import { Product } from '../src/models/Product.js'
import { Category } from '../src/models/Category.js'
import { Order, nextOrderNumber } from '../src/models/Order.js'
import { verifyPaymentSignature } from '../src/services/payments.js'
import { env } from '../src/config/env.js'

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

const S = `chk-${Date.now()}`
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

const buyable = await Product.create({
  name: `Buyable Board ${S}`,
  slug: `buyable-board-${S}`,
  categories: [cat._id], primaryCategory: cat._id, categoryAncestors: cat.ancestors ?? [],
  pricingModel: 'AREA', purchaseMode: 'BUY_NOW',
  pricing: { unit: 'sqft', rates: { B2C: 200, B2B: 150, CORPORATE: 100 } },
  taxPercent: 18, hsnCode: '4911',
  visibility: { b2c: true, b2b: true, corporate: true }, isActive: true,
})

const quoteOnly = await Product.create({
  name: `Project Signage ${S}`,
  slug: `project-signage-${S}`,
  categories: [cat._id], primaryCategory: cat._id, categoryAncestors: cat.ancestors ?? [],
  pricingModel: 'QUOTE_ONLY', purchaseMode: 'QUOTE_ONLY',
  visibility: { b2c: true, b2b: true, corporate: true }, isActive: true,
})

async function makeCustomer(label) {
  const email = `${S}-${label}@example.com`
  const u = new User({ email, name: `${label}`, role: 'CUSTOMER', status: 'ACTIVE', resolvedTier: 'B2C', isActive: true })
  await u.setPassword('customer-password-123')
  await u.save()
  const token = await call('POST', '/api/auth/login', { email, password: 'customer-password-123' })
    .then(async (r) => (await r.json()).data.accessToken)
  return { user: u, token }
}
const alice = await makeCustomer('alice')
const bob = await makeCustomer('bob')

const address = {
  name: 'Alice', phone: '9876543210', line1: '12 Test Road',
  city: 'Nagpur', state: 'Maharashtra', pincode: '440001',
}

/* ── Cart pricing ──────────────────────────────────────────────────────── */

await test('cart is priced server-side (10 sqft x 200 + 18% GST)', async () => {
  const res = await call('POST', '/api/cart/price', {
    lines: [{ slug: buyable.slug, quantity: 1, width: 2, height: 5 }],
  }, alice.token)
  const { data } = await res.json()
  assert.equal(data.subtotal, 2000)
  assert.equal(data.taxTotal, 360)
  assert.equal(data.grandTotal, 2360)
})

await test('a client-supplied price in the cart is REJECTED', async () => {
  const res = await call('POST', '/api/cart/price', {
    lines: [{ slug: buyable.slug, quantity: 1, width: 2, height: 5, unitPrice: 1, lineTotal: 1 }],
  }, alice.token)
  assert.equal(res.status, 422, 'unknown keys must be rejected, not ignored')
})

await test('quote-only products cannot be added to a cart', async () => {
  const res = await call('POST', '/api/cart/price', {
    lines: [{ slug: quoteOnly.slug, quantity: 1 }],
  }, alice.token)
  const { data } = await res.json()
  assert.equal(data.items.length, 0)
  assert.equal(data.issues.length, 1)
  assert.match(data.issues[0].message, /quoted individually/)
})

await test('an approved trade customer is charged their own rate', async () => {
  await User.updateOne({ _id: alice.user._id }, { $set: { resolvedTier: 'B2B' }, $inc: { tokenVersion: 1 } })
  const token = await call('POST', '/api/auth/login', {
    email: `${S}-alice@example.com`, password: 'customer-password-123',
  }).then(async (r) => (await r.json()).data.accessToken)

  const res = await call('POST', '/api/cart/price', {
    lines: [{ slug: buyable.slug, quantity: 1, width: 2, height: 5 }],
  }, token)
  const { data } = await res.json()
  assert.equal(data.subtotal, 1500, '10 sqft x 150 trade rate')
  alice.token = token
})

/* ── Checkout guards ───────────────────────────────────────────────────── */

await test('checkout requires a signed-in customer', async () => {
  const res = await call('POST', '/api/orders', {
    lines: [{ slug: buyable.slug, quantity: 1, width: 2, height: 5 }],
    shippingAddress: address,
  })
  assert.equal(res.status, 401)
})

await test('checkout 503s cleanly when payments are unconfigured', async () => {
  const res = await call('POST', '/api/orders', {
    lines: [{ slug: buyable.slug, quantity: 1, width: 2, height: 5 }],
    shippingAddress: address,
  }, alice.token)
  // Without Razorpay keys this is the correct, honest failure — not a crash.
  assert.equal(res.status, 503, 'must refuse to take an order it cannot charge for')
  const json = await res.json()
  assert.match(json.error.message, /not configured/i)
})

/* ── Signature verification (local, no Razorpay needed) ────────────────── */

await test('a forged payment signature is rejected', async () => {
  // Build an order directly, as the checkout endpoint would.
  const order = await Order.create({
    orderNumber: await nextOrderNumber(),
    user: alice.user._id,
    customer: { name: 'Alice', email: `${S}-alice@example.com` },
    items: [{
      product: buyable._id, name: buyable.name, slug: buyable.slug,
      quantity: 1, unitPrice: 150, lineTotal: 1500, tierCode: 'B2B',
      taxPercent: 18, taxAmount: 270,
    }],
    subtotal: 1500, taxTotal: 270, grandTotal: 1770,
    shippingAddress: address, billingAddress: address,
    payment: { providerOrderId: `order_${S}` },
  })

  const res = await call('POST', `/api/orders/${order._id}/verify`, {
    razorpay_order_id: `order_${S}`,
    razorpay_payment_id: 'pay_forged',
    razorpay_signature: 'deadbeef'.repeat(8),
  }, alice.token)

  assert.equal(res.status, 400, 'a bad signature must not confirm payment')
  const after = await Order.findById(order._id).lean()
  assert.notEqual(after.status, 'PAID', 'the order must NOT be marked paid')
  assert.equal(after.payment.signatureVerified, false)
  await Order.deleteOne({ _id: order._id })
})

await test('a signature for a DIFFERENT order cannot be replayed', async () => {
  const order = await Order.create({
    orderNumber: await nextOrderNumber(),
    user: alice.user._id,
    customer: { name: 'Alice', email: `${S}-alice@example.com` },
    items: [{ product: buyable._id, name: buyable.name, slug: buyable.slug, quantity: 1, unitPrice: 150, lineTotal: 1500, tierCode: 'B2B' }],
    subtotal: 1500, taxTotal: 0, grandTotal: 1500,
    shippingAddress: address, billingAddress: address,
    payment: { providerOrderId: `order_real_${S}` },
  })

  const res = await call('POST', `/api/orders/${order._id}/verify`, {
    razorpay_order_id: `order_SOMEONE_ELSE_${S}`, // valid-looking, wrong order
    razorpay_payment_id: 'pay_x',
    razorpay_signature: 'a'.repeat(64),
  }, alice.token)

  assert.equal(res.status, 400)
  const json = await res.json()
  assert.match(json.error.message, /does not belong/i)
  await Order.deleteOne({ _id: order._id })
})

await test('the HMAC check itself accepts a correct signature and rejects a wrong one', () => {
  const secret = env.RAZORPAY_KEY_SECRET
  if (!secret) {
    // Verify the function fails CLOSED when no secret is configured.
    assert.equal(
      verifyPaymentSignature({ orderId: 'o', paymentId: 'p', signature: 'x' }),
      false,
      'must return false rather than throwing or passing when unconfigured',
    )
    return
  }
  const good = crypto.createHmac('sha256', secret).update('o|p').digest('hex')
  assert.equal(verifyPaymentSignature({ orderId: 'o', paymentId: 'p', signature: good }), true)
  assert.equal(verifyPaymentSignature({ orderId: 'o', paymentId: 'p', signature: 'wrong' }), false)
})

/* ── Order isolation ───────────────────────────────────────────────────── */

await test('one customer cannot read another customer’s order', async () => {
  const order = await Order.create({
    orderNumber: await nextOrderNumber(),
    user: alice.user._id,
    customer: { name: 'Alice', email: `${S}-alice@example.com` },
    items: [{ product: buyable._id, name: buyable.name, slug: buyable.slug, quantity: 1, unitPrice: 150, lineTotal: 1500, tierCode: 'B2B' }],
    subtotal: 1500, taxTotal: 0, grandTotal: 1500,
    shippingAddress: address, billingAddress: address,
  })

  const mine = await call('GET', `/api/orders/${order._id}`, null, alice.token)
  assert.equal(mine.status, 200, 'the owner can read it')

  const theirs = await call('GET', `/api/orders/${order._id}`, null, bob.token)
  assert.equal(theirs.status, 404, 'another customer must get 404, not 403 — no existence leak')

  await Order.deleteOne({ _id: order._id })
})

await test('order history is scoped to the signed-in customer', async () => {
  const res = await call('GET', '/api/orders', null, bob.token)
  const { data } = await res.json()
  assert.equal(data.length, 0, 'Bob has no orders and must not see Alice’s')
})

await test('order numbers are unique under concurrency', async () => {
  const numbers = await Promise.all(Array.from({ length: 20 }, () => nextOrderNumber()))
  assert.equal(new Set(numbers).size, 20, 'atomic $inc must not hand out duplicates')
})

/* Cleanup */
await Order.deleteMany({ user: { $in: [alice.user._id, bob.user._id] } })
await Product.deleteMany({ slug: { $regex: S } })
await Category.deleteMany({ slug: { $regex: S } })
await User.deleteMany({ email: { $regex: S } })

server.close()
await disconnectDatabase()
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
