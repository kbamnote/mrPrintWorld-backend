/**
 * Bulk product upload from Excel.
 *
 *   npm run test:bulk
 *
 * Creates its own category branch (Offset → Visiting Cards, Offset → Leaflets
 * → Flyers) and cleans up after itself.
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
  } catch (e) {
    console.log(`  FAIL ${name}\n         ${e.message}`)
    failed += 1
  }
}

const S = `bulk-${Date.now()}`
await connectDatabase()
const server = createApp().listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

const admin = new User({ email: `${S}@example.com`, name: 'A', role: 'STAFF', isActive: true })
await admin.setPassword('admin-password-1234')
await admin.save()
const token = await fetch(`${base}/api/admin/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: admin.email, password: 'admin-password-1234' }),
}).then(async (r) => (await r.json()).data.accessToken)

const bulk = async (body) => {
  const res = await fetch(`${base}/api/admin/products/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  assert.equal(res.status, 200, JSON.stringify(json))
  return json.data
}

const offset = await Category.create({ name: `Offset ${S}`, slug: `offset-${S}` })
const visiting = await Category.create({ name: 'Visiting Cards', slug: `visiting-${S}`, parent: offset._id })
const leaflets = await Category.create({ name: 'Leaflets', slug: `leaflets-${S}`, parent: offset._id })
const flyers = await Category.create({ name: 'Flyers', slug: `flyers-${S}`, parent: leaflets._id })
const elsewhere = await Category.create({ name: `Elsewhere ${S}`, slug: `elsewhere-${S}` })

const cardName = `Matt Card ${S}`
const packs = [
  { qty: 1000, amounts: { B2C: 1500, B2B: 1275, CORPORATE: 1170 } },
  { qty: 500, amounts: { B2C: 1000, B2B: 850, CORPORATE: 780 } },
]

await test('a dry run says what each row will do and saves nothing', async () => {
  const data = await bulk({
    category: String(offset._id),
    rows: [{ row: 2, name: cardName, category: String(visiting._id), packs }],
  })
  assert.equal(data.dryRun, true)
  assert.deepEqual(data.results.map((r) => r.action), ['create'])
  assert.equal(await Product.countDocuments({ name: cardName }), 0)
})

await test('importing creates the product in its subcategory, priced by packs, hidden', async () => {
  const data = await bulk({
    category: String(offset._id),
    dryRun: false,
    rows: [
      {
        row: 2,
        name: cardName,
        category: String(visiting._id),
        description: 'Premium matt finish',
        specifications: ['350 GSM', 'Matt lamination'],
        unit: 'pieces',
        packs,
      },
    ],
  })
  assert.equal(data.created, 1, JSON.stringify(data.results))
  const p = await Product.findOne({ name: cardName }).lean()
  assert.equal(String(p.primaryCategory), String(visiting._id))
  assert.ok(p.categoryAncestors.map(String).includes(String(offset._id)), 'listed under Offset too')
  assert.equal(p.pricingModel, 'SLAB')
  assert.equal(p.purchaseMode, 'BUY_NOW')
  assert.deepEqual(p.pricing.slabs.map((s) => [s.minQty, s.maxQty]), [[500, 500], [1000, 1000]])
  assert.equal(p.isActive, false)
  assert.deepEqual(p.specifications, ['350 GSM', 'Matt lamination'])
})

await test('uploading the same name again updates it, and blank cells change nothing', async () => {
  const data = await bulk({
    category: String(offset._id),
    dryRun: false,
    rows: [
      {
        row: 5,
        name: cardName.toUpperCase(),
        isActive: true,
        packs: [{ qty: 500, amounts: { B2C: 1100 } }],
      },
    ],
  })
  assert.equal(data.updated, 1, JSON.stringify(data.results))
  assert.equal(await Product.countDocuments({ name: { $regex: `^matt card ${S}$`, $options: 'i' } }), 1)
  const p = await Product.findOne({ name: cardName.toUpperCase() }).lean()
  assert.equal(p.description, 'Premium matt finish', 'description kept')
  assert.equal(String(p.primaryCategory), String(visiting._id), 'still in Visiting Cards')
  assert.equal(p.isActive, true)
  assert.deepEqual(p.pricing.slabs.map((s) => s.minQty), [500])
})

await test('an existing product can be moved to another subcategory', async () => {
  const data = await bulk({
    category: String(offset._id),
    dryRun: false,
    rows: [{ row: 2, name: cardName, category: String(flyers._id) }],
  })
  assert.equal(data.updated, 1, JSON.stringify(data.results))
  const p = await Product.findOne({ name: cardName }).lean()
  assert.deepEqual(p.categories.map(String), [String(flyers._id)])
  assert.ok(p.categoryAncestors.map(String).includes(String(leaflets._id)))
})

await test('rows that cannot be filed are refused, one message each', async () => {
  const data = await bulk({
    category: String(offset._id),
    rows: [
      { row: 2, name: `No subcategory ${S}` },
      { row: 3, name: `Parent level ${S}`, category: String(leaflets._id) },
      { row: 4, name: `Outside ${S}`, category: String(elsewhere._id) },
      { row: 5, name: `Twice ${S}`, category: String(visiting._id) },
      { row: 6, name: `twice ${S}`, category: String(visiting._id) },
    ],
  })
  const byRow = Object.fromEntries(data.results.map((r) => [r.row, r]))
  assert.match(byRow[2].message, /Choose a subcategory/)
  assert.match(byRow[3].message, /subcategories inside it/)
  assert.match(byRow[4].message, /not inside/)
  assert.equal(byRow[5].action, 'create')
  assert.match(byRow[6].message, /Same product name as row 5/)
})

await test('a new product whose web address is taken elsewhere gets its own', async () => {
  await Product.create({ name: `Clash ${S}`, slug: `clash-${S}`, categories: [elsewhere._id] })
  const data = await bulk({
    category: String(offset._id),
    dryRun: false,
    rows: [{ row: 2, name: `Clash ${S}`, category: String(visiting._id) }],
  })
  assert.equal(data.created, 1, JSON.stringify(data.results))
  const created = await Product.findById(data.results[0].id).lean()
  assert.equal(created.slug, `clash-${S}-2`)
})

await Product.deleteMany({ name: { $regex: S, $options: 'i' } })
await Category.deleteMany({ slug: { $regex: S } })
await User.deleteMany({ email: { $regex: S } })

console.log(`\n${passed} passed, ${failed} failed`)
server.close()
await disconnectDatabase()
process.exit(failed === 0 ? 0 : 1)
