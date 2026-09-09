/**
 * Parity gate — the check that must pass BEFORE the frontend is switched.
 *
 *   npm run verify:parity
 *
 * Boots the API, fetches every product through the PUBLIC endpoint exactly as
 * the website will, and diffs it field-by-field against products.js. Any
 * mismatch fails. Renames from PRODUCT_RENAMES are expected and allowed; a
 * slug change is never allowed, because that is a lost URL.
 */

import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { PRODUCT_RENAMES } from '../src/data/taxonomy.js'

const FRONTEND_PRODUCTS = path.resolve(process.cwd(), '../mrPrintWorld-frontend/src/data/products.js')

const problems = []
const notes = []

function compareArray(slug, field, a, b) {
  // Coerce rather than default-param: a default only fires on `undefined`, and
  // a missing field in the static data can be `null`.
  const left = (Array.isArray(a) ? [...a] : []).sort()
  const right = (Array.isArray(b) ? [...b] : []).sort()
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    problems.push(`${slug}: ${field} differs\n      static: ${JSON.stringify(a)}\n      api:    ${JSON.stringify(b)}`)
  }
}

const { products: statics } = await import(pathToFileURL(FRONTEND_PRODUCTS).href)

await connectDatabase()
const app = createApp()
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

console.log(`\nChecking ${statics.length} products through the public API…\n`)

for (const src of statics) {
  const res = await fetch(`${base}/api/public/products/${src.slug}`)
  if (res.status !== 200) {
    problems.push(`${src.slug}: public API returned ${res.status} — the URL would 404`)
    continue
  }
  const { data } = await res.json()

  // The slug is the URL. It must be identical, always.
  if (data.slug !== src.slug) problems.push(`${src.slug}: SLUG CHANGED to "${data.slug}" — this breaks an indexed URL`)

  const expectedName = PRODUCT_RENAMES[src.slug] ?? src.name
  if (data.name !== expectedName) {
    problems.push(`${src.slug}: name is "${data.name}", expected "${expectedName}"`)
  } else if (PRODUCT_RENAMES[src.slug]) {
    notes.push(`${src.slug}: renamed to "${expectedName}" (slug preserved)`)
  }

  if ((data.shortDescription ?? '') !== (src.shortDescription ?? '')) {
    problems.push(`${src.slug}: shortDescription differs`)
  }
  if ((data.description ?? '') !== (src.description ?? '')) {
    problems.push(`${src.slug}: description differs`)
  }

  compareArray(src.slug, 'specifications', src.specifications, data.specifications)
  compareArray(src.slug, 'applications', src.applications, data.applications)
  compareArray(src.slug, 'materials', src.materials, data.materials)
  compareArray(src.slug, 'sizes', src.sizes, data.sizes)
  compareArray(src.slug, 'customization', src.customization, data.customization)

  // The migrated hotlink must still be serving, or the card renders blank.
  const apiImage = data.images?.[0]?.url ?? null
  if (src.image && apiImage !== src.image) {
    problems.push(`${src.slug}: image differs\n      static: ${src.image}\n      api:    ${apiImage}`)
  }

  if ((data.seo?.title ?? null) !== (src.seo?.title ?? src.name)) {
    // seo.title falls back to the product name in the serializer — only flag a
    // genuine mismatch, not the intended fallback.
    if (src.seo?.title && data.seo?.title !== src.seo.title) {
      problems.push(`${src.slug}: seo.title differs`)
    }
  }
}

// Every product must also be reachable in a listing, or it is invisible to
// anyone browsing rather than deep-linking.
const listRes = await fetch(`${base}/api/public/products?limit=60`)
const list = await listRes.json()
const listed = new Set(list.data.map((p) => p.slug))
for (const src of statics) {
  if (!listed.has(src.slug)) problems.push(`${src.slug}: missing from the public product listing`)
}

server.close()
await disconnectDatabase()

if (notes.length) {
  console.log('Expected differences:')
  notes.forEach((n) => console.log(`  • ${n}`))
  console.log('')
}

if (problems.length) {
  console.log(`✗ PARITY FAILED — ${problems.length} problem(s):\n`)
  problems.forEach((p) => console.log(`  • ${p}`))
  console.log('\nDo NOT switch the frontend until these are resolved.\n')
  process.exit(1)
}

console.log(`✓ PARITY PASSED — all ${statics.length} products match, every slug preserved.`)
console.log('  Safe to switch the frontend to the API.\n')
