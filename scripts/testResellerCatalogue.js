/**
 * The reseller's catalogue PDF.
 *
 *   npm run test:catalogue
 *
 * Creates its own category, products and reseller, and cleans up. Storing the
 * finished PDF needs Cloudinary, so the endpoint is only exercised where that
 * is set up; the price list and the PDF itself are checked everywhere.
 */

import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { isCloudinaryConfigured } from '../src/config/env.js'
import { User } from '../src/models/User.js'
import { Product } from '../src/models/Product.js'
import { Category } from '../src/models/Category.js'
import { ResellerPrice } from '../src/models/ResellerPrice.js'
import { buildCatalogue } from '../src/services/catalogue.js'
import { renderCataloguePdf } from '../src/services/cataloguePdf.js'
import { removeFile } from '../src/services/remoteImage.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  OK   ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL ${name}\n         ${e.message}`)
    failed += 1
  }
}

const S = `cat-${Date.now()}`
await connectDatabase()
const server = createApp().listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
const PASSWORD = 'reseller-password-123'

const cat = await Category.create({ name: `Catalogue ${S}`, slug: `catalogue-${S}` })
const cards = await Product.create({
  name: `Cat Cards ${S}`,
  slug: `cat-cards-${S}`,
  categories: [cat._id],
  primaryCategory: cat._id,
  pricingModel: 'SLAB',
  purchaseMode: 'BUY_NOW',
  specifications: ['350 GSM', 'Matt lamination'],
  sizes: ['3.5 x 2 in'],
  pricing: {
    unit: 'pieces',
    slabs: [
      { minQty: 500, maxQty: 500, amounts: { B2C: 1000, B2B: 800 } },
      { minQty: 1000, maxQty: 1000, amounts: { B2C: 1800, B2B: 1400 } },
    ],
  },
  visibility: { b2c: true, b2b: true, corporate: true },
  isActive: true,
})
const banner = await Product.create({
  name: `Cat Banner ${S}`,
  slug: `cat-banner-${S}`,
  categories: [cat._id],
  primaryCategory: cat._id,
  pricingModel: 'AREA',
  purchaseMode: 'BUY_NOW',
  pricing: { unit: 'sq.ft', rates: { B2C: 50, B2B: 40 } },
  visibility: { b2c: true, b2b: true, corporate: true },
  isActive: true,
})
const quoted = await Product.create({
  name: `Cat Quote ${S}`,
  slug: `cat-quote-${S}`,
  categories: [cat._id],
  primaryCategory: cat._id,
  pricingModel: 'QUOTE_ONLY',
  purchaseMode: 'QUOTE_ONLY',
  visibility: { b2c: true, b2b: true, corporate: true },
  isActive: true,
})
const hidden = await Product.create({
  name: `Cat Hidden ${S}`,
  slug: `cat-hidden-${S}`,
  categories: [cat._id],
  primaryCategory: cat._id,
  pricingModel: 'SLAB',
  purchaseMode: 'BUY_NOW',
  pricing: { unit: 'pieces', slabs: [{ minQty: 100, maxQty: 100, amounts: { B2C: 500, B2B: 400 } }] },
  visibility: { b2c: true, b2b: true, corporate: true },
  isActive: false, // not live: never in a catalogue
})

const reseller = new User({
  email: `${S}@example.com`,
  name: 'Akshay Test',
  role: 'CUSTOMER',
  accountType: 'B2B',
  status: 'ACTIVE',
  resolvedTier: 'B2B',
  isActive: true,
  phone: '9876500000',
  reseller: { status: 'ACTIVE', code: `CAT${String(Date.now()).slice(-6)}`, storeName: `Akshay Prints ${S}`, defaultMarkupPercent: 10 },
})
await reseller.setPassword(PASSWORD)
await reseller.save()

const token = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: reseller.email, password: PASSWORD }),
}).then(async (r) => (await r.json()).data.accessToken)
const call = (method, path) =>
  fetch(base + path, { method, headers: { authorization: `Bearer ${token}` } }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }))

const storeUrl = `https://www.mrprintworld.com/store/${reseller.reseller.code}`
const only = (catalogue, name) => catalogue.groups.flatMap((g) => g.items).find((i) => i.name === name)
let built

await test('the price list is the reseller\'s own price, from their markup', async () => {
  built = await buildCatalogue(reseller.toObject(), storeUrl)
  const item = only(built, cards.name)
  assert.deepEqual(item.rows, [
    { label: '500 pieces', price: 880 }, // 800 trade + 10%
    { label: '1,000 pieces', price: 1540 },
  ])
  assert.equal(only(built, banner.name).rows[0].price, 44, '40 per sq.ft + 10%')
  assert.equal(built.store.name, reseller.reseller.storeName)
  assert.equal(built.store.url, storeUrl)
})

await test('every product links to itself inside the reseller\'s store, with its details', async () => {
  const data = await buildCatalogue(reseller.toObject(), storeUrl)
  const item = only(data, cards.name)
  assert.equal(item.link, `https://www.mrprintworld.com/store/${reseller.reseller.code}/products/${cards.slug}`)
  assert.equal(item.specs, '350 GSM · Matt lamination · 3.5 x 2 in')
  assert.equal(only(data, banner.name).specs, null, 'a product with no details has no spec line')
})

await test('a per-product markup wins, and quote-only products say so', async () => {
  await ResellerPrice.create({ reseller: reseller._id, product: cards._id, markupPercent: 50 })
  const data = await buildCatalogue(reseller.toObject(), storeUrl)
  assert.equal(only(data, cards.name).rows[0].price, 1200, '800 trade + 50%')
  assert.equal(only(data, quoted.name).quoteOnly, true)
  assert.equal(only(data, hidden.name), undefined, 'a product that is not live is left out')
})

await test('with no markup, customers see our retail price — never below cost', async () => {
  const noMarkup = { ...reseller.toObject(), reseller: { ...reseller.toObject().reseller, defaultMarkupPercent: null } }
  await ResellerPrice.deleteMany({ reseller: reseller._id })
  const data = await buildCatalogue(noMarkup, storeUrl)
  assert.deepEqual(only(data, cards.name).rows, [
    { label: '500 pieces', price: 1000 },
    { label: '1,000 pieces', price: 1800 },
  ])
})

await test('the fingerprint changes only when something printed changes', async () => {
  const again = await buildCatalogue(reseller.toObject(), storeUrl)
  assert.equal(again.fingerprint, built.fingerprint, 'same catalogue, same fingerprint')

  await Product.updateOne({ _id: cards._id }, { $set: { 'pricing.slabs.0.amounts.B2B': 900 } })
  const priced = await buildCatalogue(reseller.toObject(), storeUrl)
  assert.notEqual(priced.fingerprint, built.fingerprint, 'a price change makes a new catalogue')
  await Product.updateOne({ _id: cards._id }, { $set: { 'pricing.slabs.0.amounts.B2B': 800 } })
})

await test('the PDF is a real, complete PDF', async () => {
  const pdf = await renderCataloguePdf(built)
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.ok(pdf.subarray(-1024).toString('latin1').includes('%%EOF'), 'not finished writing')
  assert.ok(pdf.length > 5000, `expected a real file, got ${pdf.length} bytes`)
})

await test('only a reseller can build one', async () => {
  const customer = new User({ email: `${S}-plain@example.com`, name: 'Plain', role: 'CUSTOMER', isActive: true })
  await customer.setPassword(PASSWORD)
  await customer.save()
  const plainToken = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: customer.email, password: PASSWORD }),
  }).then(async (r) => (await r.json()).data.accessToken)
  const res = await fetch(`${base}/api/reseller/catalogue`, {
    method: 'POST',
    headers: { authorization: `Bearer ${plainToken}` },
  })
  assert.equal(res.status, 403)
})

let storedId = null
if (isCloudinaryConfigured) {
  await test('the endpoint stores it, and hands back the same file until something changes', async () => {
    const first = await call('POST', '/api/reseller/catalogue')
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.match(first.body.data.url, /^https:\/\/.*\.pdf$/)
    assert.equal(first.body.data.rebuilt, true)
    storedId = (await User.findById(reseller._id).lean()).reseller.catalogue.publicId

    const second = await call('POST', '/api/reseller/catalogue')
    assert.equal(second.body.data.rebuilt, false, 'nothing changed, so no new file')
    assert.equal(second.body.data.url, first.body.data.url)

    const saved = await call('GET', '/api/reseller/catalogue')
    assert.equal(saved.body.data.url, first.body.data.url)
    assert.equal(saved.body.data.productCount, 3)
  })
} else {
  await test('without file storage set up, building one fails clearly', async () => {
    const res = await call('POST', '/api/reseller/catalogue')
    assert.equal(res.status >= 400, true)
    assert.match(JSON.stringify(res.body), /not configured/i)
  })
}

await removeFile(storedId)
await ResellerPrice.deleteMany({ reseller: reseller._id })
await Product.deleteMany({ slug: { $regex: S } })
await Category.deleteMany({ slug: { $regex: S } })
await User.deleteMany({ email: { $regex: S } })

console.log(`\n${passed} passed, ${failed} failed`)
server.close()
await disconnectDatabase()
process.exit(failed === 0 ? 0 : 1)
