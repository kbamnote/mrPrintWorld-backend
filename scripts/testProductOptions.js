/**
 * Product specification fields (options) — pricing and enforcement.
 *
 *   node scripts/testProductOptions.js
 *
 * The claims being verified:
 *   - a choice adds its surcharge to the price, per customer tier
 *   - a REQUIRED field with nothing chosen has no price, and says what to choose
 *   - the same rule holds in the cart, where a client could simply omit it
 *   - an invented option or value is ignored rather than trusted
 */

import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { User } from '../src/models/User.js'
import { Product } from '../src/models/Product.js'
import { Category } from '../src/models/Category.js'
import { OptionGroup } from '../src/models/OptionGroup.js'

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

const S = `opt-${Date.now()}`
await connectDatabase()
const app = createApp()
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
const PASSWORD = 'customer-password-123'

const call = (method, path, body, token) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
const json = async (res) => (await res.json()).data

const cat = (await Category.create({ name: `Test category ${S}`, slug: `test-cat-${S}` })).toObject()

const paper = await OptionGroup.create({
  code: `PAPER_${String(Date.now()).slice(-6)}`,
  label: 'Paper / card stock',
  inputType: 'DROPDOWN',
  values: [
    { code: 'ART_CARD', label: 'Art card', order: 0, deltaType: 'FLAT' },
    { code: 'TEXTURED', label: 'Textured', order: 1, deltaType: 'FLAT', priceDelta: { B2C: 100, B2B: 60 } },
  ],
})

const product = await Product.create({
  name: `Spec Cards ${S}`,
  slug: `spec-cards-${S}`,
  categories: [cat._id], primaryCategory: cat._id, categoryAncestors: cat.ancestors ?? [],
  pricingModel: 'FIXED', purchaseMode: 'BUY_NOW',
  pricing: { unit: 'pack', amounts: { B2C: 500, B2B: 400 } },
  options: [{ optionGroup: paper._id, order: 0, required: true }],
  visibility: { b2c: true, b2b: true, corporate: true }, isActive: true,
})

const customer = new User({
  email: `${S}@example.com`, name: 'Spec Customer', role: 'CUSTOMER',
  status: 'ACTIVE', resolvedTier: 'B2C', isActive: true,
})
await customer.setPassword(PASSWORD)
await customer.save()
const token = await call('POST', '/api/auth/login', { email: customer.email, password: PASSWORD })
  .then(async (r) => (await r.json()).data.accessToken)

const price = (selections) =>
  call('POST', '/api/public/pricing/calculate', { slug: product.slug, quantity: 1, selections }, token).then(json)

await test('a required field with nothing chosen has no price, and says what to choose', async () => {
  const data = await price([])
  assert.equal(data.quotable, false)
  assert.match(data.reason, /Paper \/ card stock/)
  assert.deepEqual(data.requiresSelection.map((r) => r.label), ['Paper / card stock'])
})

await test('a choice with no surcharge prices at the base rate', async () => {
  const data = await price([{ group: paper.code, value: 'ART_CARD' }])
  assert.equal(data.total, 500)
})

await test('a choice with a surcharge adds it', async () => {
  const data = await price([{ group: paper.code, value: 'TEXTURED' }])
  assert.equal(data.total, 600, '500 base + 100 for textured stock')
})

await test('a trade customer pays the trade surcharge', async () => {
  await User.updateOne({ _id: customer._id }, { $set: { resolvedTier: 'B2B' } })
  const data = await price([{ group: paper.code, value: 'TEXTURED' }])
  assert.equal(data.total, 460, '400 trade base + 60 trade surcharge')
  await User.updateOne({ _id: customer._id }, { $set: { resolvedTier: 'B2C' } })
})

await test('an invented value is ignored, not trusted', async () => {
  const data = await price([{ group: paper.code, value: 'FREE_PLEASE' }])
  assert.equal(data.quotable, false, 'an unknown value leaves the required field unanswered')
})

await test('the cart refuses a line with a required field unanswered', async () => {
  const data = await json(await call('POST', '/api/cart/price', { lines: [{ slug: product.slug, quantity: 1 }] }, token))
  assert.equal(data.items.length, 0)
  assert.match(data.issues[0].message, /choose Paper \/ card stock/)
})

await test('the cart prices the chosen specification', async () => {
  const lines = [{ slug: product.slug, quantity: 2, selections: [{ group: paper.code, value: 'TEXTURED' }] }]
  const data = await json(await call('POST', '/api/cart/price', { lines }, token))
  assert.equal(data.subtotal, 1100, '2 x 500 + 100 once on the line')
  assert.equal(data.items[0].selections[0].valueLabel, 'Textured', 'recorded for production')
})

/* ── Different prices for the same field on different products ─────────── */

const letterhead = await Product.create({
  name: `Spec Letterhead ${S}`,
  slug: `spec-letterhead-${S}`,
  categories: [cat._id], primaryCategory: cat._id, categoryAncestors: cat.ancestors ?? [],
  pricingModel: 'FIXED', purchaseMode: 'BUY_NOW',
  pricing: { unit: 'pack', amounts: { B2C: 500, B2B: 400 } },
  // Same field as the cards, but textured stock costs 250 here, for retail only.
  options: [{ optionGroup: paper._id, order: 0, required: true, valueOverrides: { TEXTURED: { B2C: 250 } } }],
  visibility: { b2c: true, b2b: true, corporate: true }, isActive: true,
})

const priceOf = (slug, selections) =>
  call('POST', '/api/public/pricing/calculate', { slug, quantity: 1, selections }, token).then(json)

await test('the same choice can cost more on one product than on another', async () => {
  const cards = await priceOf(product.slug, [{ group: paper.code, value: 'TEXTURED' }])
  const letter = await priceOf(letterhead.slug, [{ group: paper.code, value: 'TEXTURED' }])
  assert.equal(cards.total, 600, 'the cards use the library surcharge of 100')
  assert.equal(letter.total, 750, 'the letterhead charges its own 250 for the same choice')
})

await test('a customer type left blank on a product falls back to the library price', async () => {
  await User.updateOne({ _id: customer._id }, { $set: { resolvedTier: 'B2B' } })
  const letter = await priceOf(letterhead.slug, [{ group: paper.code, value: 'TEXTURED' }])
  assert.equal(letter.total, 460, '400 trade base + the library trade surcharge of 60')
  await User.updateOne({ _id: customer._id }, { $set: { resolvedTier: 'B2C' } })
})

await test('a choice not priced differently keeps its library price on that product', async () => {
  const letter = await priceOf(letterhead.slug, [{ group: paper.code, value: 'ART_CARD' }])
  assert.equal(letter.total, 500)
})

await test('the cart charges the product’s own price for the choice', async () => {
  const lines = [{ slug: letterhead.slug, quantity: 1, selections: [{ group: paper.code, value: 'TEXTURED' }] }]
  const data = await json(await call('POST', '/api/cart/price', { lines }, token))
  assert.equal(data.subtotal, 750)
})

/* ── Choice prices that change with the quantity pack ──────────────────── */

const packCards = await Product.create({
  name: `Spec Pack Cards ${S}`,
  slug: `spec-pack-cards-${S}`,
  categories: [cat._id], primaryCategory: cat._id, categoryAncestors: cat.ancestors ?? [],
  pricingModel: 'SLAB', purchaseMode: 'BUY_NOW',
  pricing: {
    unit: 'pieces',
    slabs: [
      { minQty: 1000, maxQty: 1000, amounts: { B2C: 900, B2B: 700 } },
      { minQty: 2000, maxQty: 2000, amounts: { B2C: 1600, B2B: 1300 } },
    ],
  },
  options: [{
    optionGroup: paper._id, order: 0, required: true,
    // Textured stock: 120 at any quantity, but 260 on the 2,000 pack (retail only).
    valueOverrides: { TEXTURED: { B2C: 120 } },
    packOverrides: { 2000: { TEXTURED: { B2C: 260 } } },
  }],
  visibility: { b2c: true, b2b: true, corporate: true }, isActive: true,
})

const priceAt = (slug, quantity, selections) =>
  call('POST', '/api/public/pricing/calculate', { slug, quantity, selections }, token).then(json)
const textured = [{ group: paper.code, value: 'TEXTURED' }]

await test('a pack with no price of its own uses the all-quantities price', async () => {
  assert.equal((await priceAt(packCards.slug, 1000, textured)).total, 1020, '900 pack + 120')
})

await test('a pack with its own price for the choice charges that', async () => {
  assert.equal((await priceAt(packCards.slug, 2000, textured)).total, 1860, '1600 pack + 260')
})

await test('the quantity dropdown prices every pack with that pack’s own choice price', async () => {
  const data = await priceAt(packCards.slug, 1000, textured)
  assert.deepEqual(
    data.quantityOptions.map((b) => [b.quantity, b.total]),
    [
      [1000, 1020],
      [2000, 1860],
    ],
  )
})

await test('a customer type with no pack price falls back through to the library', async () => {
  await User.updateOne({ _id: customer._id }, { $set: { resolvedTier: 'B2B' } })
  assert.equal((await priceAt(packCards.slug, 2000, textured)).total, 1360, '1300 trade pack + library trade 60')
  await User.updateOne({ _id: customer._id }, { $set: { resolvedTier: 'B2C' } })
})

await test('the cart charges the pack’s own price for the choice', async () => {
  const lines = [{ slug: packCards.slug, quantity: 2000, selections: textured }]
  const data = await json(await call('POST', '/api/cart/price', { lines }, token))
  assert.equal(data.subtotal, 1860)
})

/* ── Choices not offered on some packs ─────────────────────────────────── */

const availCards = await Product.create({
  name: `Spec Avail Cards ${S}`,
  slug: `spec-avail-cards-${S}`,
  categories: [cat._id], primaryCategory: cat._id, categoryAncestors: cat.ancestors ?? [],
  pricingModel: 'SLAB', purchaseMode: 'BUY_NOW',
  pricing: {
    unit: 'pieces',
    slabs: [
      { minQty: 1000, maxQty: 1000, amounts: { B2C: 900 } },
      { minQty: 2000, maxQty: 2000, amounts: { B2C: 1600 } },
      { minQty: 3000, maxQty: 3000, amounts: { B2C: 2200 } },
    ],
  },
  options: [{
    optionGroup: paper._id, order: 0, required: true,
    // Textured is not made in 2,000s; the 3,000 pack offers no paper choice at all.
    packUnavailable: { 2000: ['TEXTURED'], 3000: ['ART_CARD', 'TEXTURED'] },
  }],
  visibility: { b2c: true, b2b: true, corporate: true }, isActive: true,
})

await test('a choice not offered on a pack has no price there, and says why', async () => {
  const data = await priceAt(availCards.slug, 2000, textured)
  assert.equal(data.quotable, false)
  assert.match(data.reason, /Textured is not available in packs of 2,000/)
})

await test('the quantity list marks the packs that do not offer the chosen option', async () => {
  const data = await priceAt(availCards.slug, 1000, textured)
  assert.deepEqual(
    data.quantityOptions.map((b) => [b.quantity, b.available]),
    [
      [1000, true],
      [2000, false],
      [3000, false],
    ],
  )
  assert.equal(data.quantityOptions[0].total, 1000, '900 pack + library 100 for textured')
})

await test('a required field with no choice offered on a pack is not demanded there', async () => {
  const data = await priceAt(availCards.slug, 3000, [])
  assert.equal(data.quotable, true)
  assert.equal(data.total, 2200)
})

await test('the product page tells the storefront which packs each choice is missing from', async () => {
  const detail = await json(await call('GET', `/api/public/products/${availCards.slug}`, null, token))
  const missingFrom = Object.fromEntries(detail.options[0].values.map((v) => [v.code, v.unavailableFor ?? []]))
  assert.deepEqual(missingFrom.TEXTURED, [2000, 3000])
  assert.deepEqual(missingFrom.ART_CARD, [3000])
})

await test('the cart refuses a choice on a pack that does not offer it', async () => {
  const lines = [{ slug: availCards.slug, quantity: 2000, selections: textured }]
  const data = await json(await call('POST', '/api/cart/price', { lines }, token))
  assert.equal(data.items.length, 0)
  assert.match(data.issues[0].message, /Textured is not available in packs of 2,000/)
})

/* ── A field priced by another field's choice (sides by size) ──────────── */

const sizeGroup = await OptionGroup.create({
  code: `SIZE_${String(Date.now()).slice(-6)}`,
  label: 'Size',
  inputType: 'DROPDOWN',
  values: [{ code: 'A5', label: 'A5' }, { code: 'A4', label: 'A4' }],
})
const sidesGroup = await OptionGroup.create({
  code: `SIDES_${String(Date.now()).slice(-6)}`,
  label: 'Printing sides',
  inputType: 'RADIO',
  values: [
    { code: 'SINGLE', label: 'Single side' },
    { code: 'BOTH', label: 'Both sides', priceDelta: { B2C: 400 } },
  ],
})

const flyers = await Product.create({
  name: `Spec Flyers ${S}`,
  slug: `spec-flyers-${S}`,
  categories: [cat._id], primaryCategory: cat._id, categoryAncestors: cat.ancestors ?? [],
  pricingModel: 'SLAB', purchaseMode: 'BUY_NOW',
  pricing: {
    unit: 'pieces',
    slabs: [
      { minQty: 1000, maxQty: 1000, amounts: { B2C: 1000 } },
      { minQty: 2000, maxQty: 2000, amounts: { B2C: 1800 } },
    ],
  },
  options: [
    { optionGroup: sizeGroup._id, order: 0 },
    {
      optionGroup: sidesGroup._id,
      order: 1,
      dependsOn: sizeGroup._id,
      // Both sides: +300 on A5, +500 on A4, and +850 on A4 in the 2,000 pack.
      driverPrices: {
        A5: { every: { BOTH: { B2C: 300 } } },
        A4: { every: { BOTH: { B2C: 500 } }, packs: { 2000: { BOTH: { B2C: 850 } } } },
      },
    },
  ],
  visibility: { b2c: true, b2b: true, corporate: true }, isActive: true,
})

const sized = (size, side) => [
  { group: sizeGroup.code, value: size },
  { group: sidesGroup.code, value: side },
]

await test('a choice can cost a different amount for each size', async () => {
  assert.equal((await priceAt(flyers.slug, 1000, sized('A5', 'BOTH'))).total, 1300, '1000 + 300 on A5')
  assert.equal((await priceAt(flyers.slug, 1000, sized('A4', 'BOTH'))).total, 1500, '1000 + 500 on A4')
})

await test('and a different amount again on a pack for that size', async () => {
  assert.equal((await priceAt(flyers.slug, 2000, sized('A4', 'BOTH'))).total, 2650, '1800 + 850 on A4 at 2,000')
  assert.equal((await priceAt(flyers.slug, 2000, sized('A5', 'BOTH'))).total, 2100, '1800 + A5 every-quantity 300')
})

await test('with no size chosen, the field’s own price applies', async () => {
  const data = await priceAt(flyers.slug, 1000, [{ group: sidesGroup.code, value: 'BOTH' }])
  assert.equal(data.total, 1400, '1000 + library 400')
})

await test('the quantity list prices each pack for the chosen size', async () => {
  const data = await priceAt(flyers.slug, 1000, sized('A4', 'BOTH'))
  assert.deepEqual(
    data.quantityOptions.map((b) => [b.quantity, b.total]),
    [
      [1000, 1500],
      [2000, 2650],
    ],
  )
})

await test('the cart prices by size whatever order the choices arrive in', async () => {
  const lines = [
    {
      slug: flyers.slug,
      quantity: 2000,
      // Sides listed BEFORE size: the size must still be found.
      selections: [
        { group: sidesGroup.code, value: 'BOTH' },
        { group: sizeGroup.code, value: 'A4' },
      ],
    },
  ]
  const data = await json(await call('POST', '/api/cart/price', { lines }, token))
  assert.equal(data.subtotal, 2650)
})

await OptionGroup.deleteMany({ _id: { $in: [sizeGroup._id, sidesGroup._id] } })

await Product.deleteMany({ slug: { $regex: S } })
await OptionGroup.deleteMany({ _id: paper._id })
await Category.deleteMany({ slug: { $regex: S } })
await User.deleteMany({ email: { $regex: S } })

server.close()
await disconnectDatabase()
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
