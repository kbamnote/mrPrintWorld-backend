/**
 * Regression: saving a product after uploading an image.
 *
 *   node scripts/testImageRoundTrip.js
 *
 * The bug this guards: Mongoose adds `_id` to every image subdocument, the
 * admin form loads the product WITH those ids, sends them back on save, and
 * the strict write schema rejected `_id` as an unrecognised key. Uploading an
 * image made a product permanently unsaveable.
 */

import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { User } from '../src/models/User.js'
import { Product } from '../src/models/Product.js'
import { Category } from '../src/models/Category.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  OK   ${name}`); passed += 1 }
  catch (e) { console.log(`  FAIL ${name}\n         ${e.message}`); failed += 1 }
}

const S = `img-${Date.now()}`
await connectDatabase()
const app = createApp()
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

const admin = new User({ email: `${S}@example.com`, name: 'A', role: 'ADMIN', isActive: true })
await admin.setPassword('admin-password-1234')
await admin.save()
const token = await fetch(`${base}/api/admin/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: admin.email, password: 'admin-password-1234' }),
}).then(async (r) => (await r.json()).data.accessToken)

const call = (m, p, b) => fetch(base + p, {
  method: m,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  ...(b ? { body: JSON.stringify(b) } : {}),
})

const cat = await Category.findOne({ slug: 'outdoor-signage' }).lean()
let productId

await test('create a product with an image', async () => {
  const res = await call('POST', '/api/admin/products', {
    name: `Image Test ${S}`,
    categories: [String(cat._id)],
    images: [{ url: 'https://res.cloudinary.com/demo/image/upload/sample.png', publicId: 'x/y', alt: 'A', isPrimary: true }],
  })
  const json = await res.json()
  assert.equal(res.status, 201, JSON.stringify(json))
  productId = json.data._id ?? json.data.id
})

await test('re-saving the product as the admin form does it succeeds', async () => {
  // Exactly the round trip that used to fail: load, then send back.
  const loaded = await call('GET', `/api/admin/products/${productId}`).then((r) => r.json())
  const images = loaded.data.images

  const res = await call('PATCH', `/api/admin/products/${productId}`, {
    name: loaded.data.name,
    categories: loaded.data.categories.map((c) => String(c._id ?? c)),
    images, // verbatim, _id and all
  })
  const json = await res.json()
  assert.equal(res.status, 200, `save must succeed; got ${res.status} ${JSON.stringify(json.error ?? {})}`)
})

await test('a stray _id never reaches the stored document', async () => {
  const stored = await Product.findById(productId).lean()
  assert.ok(stored.images.length > 0, 'image survived the round trip')
  assert.ok(!('_id' in stored.images[0]), 'stored image must not carry an _id')
  assert.equal(stored.images[0].url, 'https://res.cloudinary.com/demo/image/upload/sample.png')
})

await Product.deleteMany({ _id: productId })
await User.deleteOne({ _id: admin._id })
server.close()
await disconnectDatabase()
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
