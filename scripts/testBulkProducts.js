/**
 * Bulk product upload from Excel.
 *
 *   npm run test:bulk
 *
 * Creates its own category branch (Offset → Visiting Cards, Offset → Leaflets
 * → Flyers) and its own fields, and cleans up after itself. Copying a photo
 * from a link needs Cloudinary, so that one check runs only where it is set up.
 */

import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { isCloudinaryConfigured } from '../src/config/env.js'
import { User } from '../src/models/User.js'
import { Product } from '../src/models/Product.js'
import { Category } from '../src/models/Category.js'
import { OptionGroup } from '../src/models/OptionGroup.js'
import { directImageLink, removeImportedImages } from '../src/services/remoteImage.js'

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
const CODE = String(Date.now()).slice(-6)
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
const inOffset = (rows, dryRun = false) => bulk({ category: String(offset._id), dryRun, rows })

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
  const data = await inOffset([
    {
      row: 2,
      name: cardName,
      category: String(visiting._id),
      description: 'Premium matt finish',
      specifications: ['350 GSM', 'Matt lamination'],
      unit: 'pieces',
      packs,
    },
  ])
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
  const data = await inOffset([
    { row: 5, name: cardName.toUpperCase(), isActive: true, packs: [{ qty: 500, amounts: { B2C: 1100 } }] },
  ])
  assert.equal(data.updated, 1, JSON.stringify(data.results))
  assert.equal(await Product.countDocuments({ name: { $regex: `^matt card ${S}$`, $options: 'i' } }), 1)
  const p = await Product.findOne({ name: cardName.toUpperCase() }).lean()
  assert.equal(p.description, 'Premium matt finish', 'description kept')
  assert.equal(String(p.primaryCategory), String(visiting._id), 'still in Visiting Cards')
  assert.equal(p.isActive, true)
  assert.deepEqual(p.pricing.slabs.map((s) => s.minQty), [500])
})

await test('an existing product can be moved to another subcategory', async () => {
  const data = await inOffset([{ row: 2, name: cardName, category: String(flyers._id) }])
  assert.equal(data.updated, 1, JSON.stringify(data.results))
  const p = await Product.findOne({ name: cardName }).lean()
  assert.deepEqual(p.categories.map(String), [String(flyers._id)])
  assert.ok(p.categoryAncestors.map(String).includes(String(leaflets._id)))
})

await test('rows that cannot be filed are refused, one message each', async () => {
  const data = await inOffset(
    [
      { row: 2, name: `No subcategory ${S}` },
      { row: 3, name: `Parent level ${S}`, category: String(leaflets._id) },
      { row: 4, name: `Outside ${S}`, category: String(elsewhere._id) },
      { row: 5, name: `Twice ${S}`, category: String(visiting._id) },
      { row: 6, name: `twice ${S}`, category: String(visiting._id) },
    ],
    true,
  )
  const byRow = Object.fromEntries(data.results.map((r) => [r.row, r]))
  assert.match(byRow[2].message, /Choose a subcategory/)
  assert.match(byRow[3].message, /subcategories inside it/)
  assert.match(byRow[4].message, /not inside/)
  assert.equal(byRow[5].action, 'create')
  assert.match(byRow[6].message, /Same product name as row 5/)
})

await test('a new product whose web address is taken elsewhere gets its own', async () => {
  await Product.create({ name: `Clash ${S}`, slug: `clash-${S}`, categories: [elsewhere._id] })
  const data = await inOffset([{ row: 2, name: `Clash ${S}`, category: String(visiting._id) }])
  assert.equal(data.created, 1, JSON.stringify(data.results))
  const created = await Product.findById(data.results[0].id).lean()
  assert.equal(created.slug, `clash-${S}-2`)
})

/* ── Option fields ─────────────────────────────────────────────────────── */

const size = await OptionGroup.create({
  code: `SZ_${CODE}`,
  label: `Size ${S}`,
  inputType: 'DROPDOWN',
  values: [{ code: 'A5', label: 'A5' }, { code: 'A4', label: 'A4' }],
})
const sides = await OptionGroup.create({
  code: `SD_${CODE}`,
  label: `Sides ${S}`,
  inputType: 'RADIO',
  values: [{ code: 'SINGLE', label: 'Single side' }, { code: 'BOTH', label: 'Both sides' }],
})
const flyerName = `Gloss Flyer ${S}`
const flyerPacks = [
  { qty: 1000, amounts: { B2C: 900 } },
  { qty: 2000, amounts: { B2C: 1600 } },
]
const sidesOption = {
  optionGroup: String(sides._id),
  dependsOn: String(size._id),
  packOverrides: { 2000: { BOTH: { B2C: 350 } } },
  packUnavailable: { 2000: ['SINGLE'] },
  driverPrices: { A4: { every: { BOTH: { B2C: 500 } }, packs: { 1000: { BOTH: { B2C: 800 } } } } },
}

await test('fields come in with prices per choice, per pack, per other field, and not-available', async () => {
  const data = await inOffset([
    {
      row: 2,
      name: flyerName,
      category: String(flyers._id),
      packs: flyerPacks,
      options: [{ optionGroup: String(size._id), required: true, valueOverrides: { A4: { B2C: 100 } } }, sidesOption],
    },
  ])
  assert.equal(data.created, 1, JSON.stringify(data.results))
  const p = await Product.findOne({ name: flyerName }).lean()
  assert.equal(p.options.length, 2)
  assert.equal(p.options[0].required, true)
  assert.deepEqual(p.options[0].valueOverrides, { A4: { B2C: 100 } })
  assert.equal(String(p.options[1].dependsOn), String(size._id))
  assert.deepEqual(p.options[1].packUnavailable, { 2000: ['SINGLE'] })
  assert.equal(p.options[1].driverPrices.A4.packs['1000'].BOTH.B2C, 800)
})

await test('a field price for a pack the product does not sell is refused', async () => {
  const data = await inOffset(
    [{ row: 2, name: flyerName, options: [{ optionGroup: String(size._id), packOverrides: { 3000: { A4: { B2C: 1 } } } }] }],
    true,
  )
  assert.match(data.results[0].message, /3,000 is not one of this product's quantity packs/)
})

await test('a choice the field does not have is refused', async () => {
  const data = await inOffset(
    [{ row: 2, name: flyerName, options: [{ optionGroup: String(size._id), valueOverrides: { GOLD: { B2C: 1 } } }] }],
    true,
  )
  assert.match(data.results[0].message, /has no choice "GOLD"/)
})

await test('a product only on the Options sheet gets its fields replaced, keeping its renamed field', async () => {
  await Product.updateOne({ name: flyerName }, { $set: { 'options.0.labelOverride': 'Paper size' } })
  const data = await inOffset([{ row: 100_002, name: flyerName, optionsOnly: true, options: [{ optionGroup: String(size._id) }] }])
  assert.equal(data.updated, 1, JSON.stringify(data.results))
  const p = await Product.findOne({ name: flyerName }).lean()
  assert.equal(p.options.length, 1)
  assert.equal(p.options[0].labelOverride, 'Paper size')
  assert.equal(p.options[0].valueOverrides, undefined, 'prices not on the sheet are gone')
  assert.deepEqual(p.pricing.slabs.map((s) => s.minQty), [1000, 2000], 'packs untouched')
})

await test('a product only on the Options sheet that does not exist is refused', async () => {
  const data = await inOffset([{ row: 100_003, name: `Ghost ${S}`, optionsOnly: true, options: [{ optionGroup: String(size._id) }] }], true)
  assert.match(data.results[0].message, /Products sheet first/)
})

/* ── Photo links ───────────────────────────────────────────────────────── */

await test('share links are turned into links to the photo itself', async () => {
  assert.equal(
    directImageLink('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing'),
    'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp',
  )
  assert.equal(
    directImageLink('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp'),
    'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp',
  )
  assert.equal(directImageLink('https://www.dropbox.com/s/abc/card.jpg?dl=0'), 'https://www.dropbox.com/s/abc/card.jpg?raw=1')
  assert.equal(directImageLink('card.jpg'), null)
})

await test('a photo the product already has is not added again; a bad link is refused', async () => {
  const photo = 'https://res.cloudinary.com/elsewhere/image/upload/v1/card.jpg'
  await Product.updateOne({ name: cardName }, { $set: { images: [{ url: photo, isPrimary: true }] } })

  const same = await inOffset([{ row: 2, name: cardName, images: [photo] }])
  assert.equal(same.updated, 1, JSON.stringify(same.results))
  assert.equal(same.results[0].newImages, 0)
  assert.equal((await Product.findOne({ name: cardName }).lean()).images.length, 1)

  const bad = await inOffset([{ row: 2, name: cardName, images: ['card.jpg'] }], true)
  assert.match(bad.results[0].message, /Image 1 is not a web link/)
})

await test('a dry run counts new photos without copying them', async () => {
  const data = await inOffset([{ row: 2, name: cardName, images: ['https://example.com/new-card.jpg'] }], true)
  assert.equal(data.results[0].action, 'update')
  assert.equal(data.results[0].newImages, 1)
  assert.equal((await Product.findOne({ name: cardName }).lean()).images.length, 1)
})

const copiedIds = []
if (isCloudinaryConfigured) {
  await test('a photo link is copied into our image storage, once', async () => {
    const link = 'https://res.cloudinary.com/demo/image/upload/sample.jpg'
    const data = await inOffset([{ row: 2, name: cardName, images: [link] }])
    assert.equal(data.updated, 1, JSON.stringify(data.results))
    const again = await inOffset([{ row: 2, name: cardName, images: [link] }])
    assert.equal(again.results[0].newImages, 0)
    const p = await Product.findOne({ name: cardName }).lean()
    assert.equal(p.images.length, 2)
    assert.equal(p.images[1].sourceUrl, link)
    copiedIds.push(p.images[1].publicId)
  })
} else {
  await test('without image storage set up, copying a photo fails that row clearly', async () => {
    const data = await inOffset([{ row: 2, name: cardName, images: ['https://example.com/new-card.jpg'] }])
    assert.match(data.results[0].message, /Image 1 could not be copied/)
    assert.equal((await Product.findOne({ name: cardName }).lean()).images.length, 1, 'nothing saved')
  })
}

await removeImportedImages(copiedIds.filter(Boolean))
await Product.deleteMany({ name: { $regex: S, $options: 'i' } })
await OptionGroup.deleteMany({ _id: { $in: [size._id, sides._id] } })
await Category.deleteMany({ slug: { $regex: S } })
await User.deleteMany({ email: { $regex: S } })

console.log(`\n${passed} passed, ${failed} failed`)
server.close()
await disconnectDatabase()
process.exit(failed === 0 ? 0 : 1)
