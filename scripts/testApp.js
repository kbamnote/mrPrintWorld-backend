/**
 * HTTP-layer checks that do NOT need a database.
 *
 *   node scripts/testApp.js
 *
 * The important ones are the security assertions: that the pricing endpoint
 * rejects any attempt to name a tier, and that the admin surface is closed by
 * default. Both are verified against the real Express app, not by reading code.
 */

import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'

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

const app = createApp()
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

await test('GET /health responds', async () => {
  const res = await fetch(`${base}/health`)
  const json = await res.json()
  assert.equal(res.status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.service, 'mrprintworld-backend')
})

await test('unknown route → 404 with a JSON error shape', async () => {
  const res = await fetch(`${base}/api/nope`)
  const json = await res.json()
  assert.equal(res.status, 404)
  assert.equal(json.ok, false)
  assert.ok(json.error.message)
})

await test('x-powered-by is not advertised', async () => {
  const res = await fetch(`${base}/health`)
  assert.equal(res.headers.get('x-powered-by'), null)
})

await test('helmet security headers are applied', async () => {
  const res = await fetch(`${base}/health`)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.ok(res.headers.get('strict-transport-security'))
})

/* ── The security guarantee from the brief ─────────────────────────────── */

await test('SECURITY: pricing rejects a payload that names a tier', async () => {
  const res = await post('/api/public/pricing/calculate', {
    slug: 'acp-sign-board',
    quantity: 1,
    tier: 'CORPORATE', // ← the attack
  })
  const json = await res.json()
  assert.equal(res.status, 422, 'must be rejected, not silently ignored')
  assert.equal(json.ok, false)
  // The 422 fires in validation, BEFORE any database work — so this holds
  // even with no Mongo connection, which is why it is testable here.
  assert.match(JSON.stringify(json.error), /tier/i)
})

await test('SECURITY: pricing rejects an injected price field', async () => {
  const res = await post('/api/public/pricing/calculate', {
    slug: 'acp-sign-board',
    quantity: 1,
    price: 1,
    total: 1,
  })
  assert.equal(res.status, 422)
})

await test('SECURITY: NoSQL operator in a slug is rejected by the string schema', async () => {
  const res = await post('/api/public/pricing/calculate', { slug: { $ne: '' }, quantity: 1 })
  assert.equal(res.status, 422, 'an object where a string belongs must never reach Mongo')
})

await test('SECURITY: admin surface is closed to anonymous callers', async () => {
  for (const path of ['/api/admin/products', '/api/admin/categories', '/api/admin/option-groups']) {
    const res = await fetch(base + path)
    assert.equal(res.status, 401, `${path} should be 401, got ${res.status}`)
  }
})

await test('SECURITY: a forged bearer token does not authenticate', async () => {
  const res = await fetch(`${base}/api/admin/products`, {
    headers: { authorization: 'Bearer not.a.real.token' },
  })
  assert.equal(res.status, 401)
})

await test('admin login is reachable without auth (and rejects empty creds)', async () => {
  const res = await post('/api/admin/auth/login', {})
  assert.equal(res.status, 422, 'reachable, but validated')
})

await test('valid pricing payload passes validation and reaches the handler', async () => {
  // No database here, so this 500s at the query — the point is that it got
  // PAST validation, proving a well-formed request is not being rejected.
  const res = await post('/api/public/pricing/calculate', {
    slug: 'acp-sign-board',
    quantity: 2,
    width: 4,
    height: 8,
    selections: [{ group: 'LIGHTING', value: 'BACKLIT' }],
  })
  assert.notEqual(res.status, 422, 'a legitimate request must not be rejected by validation')
})

server.close()
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
