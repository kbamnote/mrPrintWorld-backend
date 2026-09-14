/**
 * Public category tree — what shoppers can browse.
 *
 *   node scripts/testCategories.js
 *
 * The claims being verified:
 *   - a visible category with no products is still listed, marked hasProducts: false
 *   - a category with a live product is marked hasProducts: true, and so is its parent
 *   - a category the admin hides is not listed, and neither is anything inside it
 *   - a category page lists all its visible subcategories, empty or not
 */

import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { Category } from '../src/models/Category.js'
import { Product } from '../src/models/Product.js'

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

const S = `cat-${Date.now()}`
await connectDatabase()
const app = createApp()
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
const get = (path) => fetch(base + path).then(async (r) => (await r.json()).data)

const make = (fields) => new Category(fields).save()
const root = await make({ name: `Root ${S}`, slug: `root-${S}` })
const empty = await make({ name: `Empty ${S}`, slug: `empty-${S}`, parent: root._id })
const full = await make({ name: `Full ${S}`, slug: `full-${S}`, parent: root._id })
const hidden = await make({ name: `Hidden ${S}`, slug: `hidden-${S}`, parent: root._id, isActive: false })
await make({ name: `Inner ${S}`, slug: `inner-${S}`, parent: hidden._id })

await Product.create({
  name: `Live Product ${S}`,
  slug: `live-product-${S}`,
  categories: [full._id], primaryCategory: full._id, categoryAncestors: full.ancestors ?? [],
  pricingModel: 'QUOTE_ONLY', purchaseMode: 'QUOTE_ONLY',
  visibility: { b2c: true, b2b: true, corporate: true }, isActive: true,
})

const flatten = (nodes) => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])])
const tree = await get('/api/public/categories')
const bySlug = new Map(flatten(tree).map((n) => [n.slug, n]))

await test('a visible category with no products is still listed', async () => {
  const node = bySlug.get(`empty-${S}`)
  assert.ok(node, 'the empty category must appear for shoppers')
  assert.equal(node.hasProducts, false)
})

await test('a category with a live product, and its parent, are marked as having products', async () => {
  assert.equal(bySlug.get(`full-${S}`)?.hasProducts, true)
  assert.equal(bySlug.get(`root-${S}`)?.hasProducts, true)
})

await test('a hidden category is not listed, and neither is anything inside it', async () => {
  assert.equal(bySlug.has(`hidden-${S}`), false)
  assert.equal(bySlug.has(`inner-${S}`), false)
})

await test('a category page lists every visible subcategory, empty or not', async () => {
  const page = await get(`/api/public/categories/root-${S}`)
  const slugs = page.children.map((c) => c.slug).sort()
  assert.deepEqual(slugs, [`empty-${S}`, `full-${S}`].sort())
})

await Product.deleteMany({ slug: { $regex: S } })
await Category.deleteMany({ slug: { $regex: S } })

server.close()
await disconnectDatabase()
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
