/**
 * Creates the first administrator.
 *
 *   npm run seed:admin -- --email you@example.com --name "Abid Khan" --password "..."
 *
 * If --password is omitted a strong one is generated and printed once. There
 * is no default password: a backend that ships with admin/admin is a backend
 * that gets found by a scanner.
 */

import crypto from 'node:crypto'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { User } from '../src/models/User.js'

function arg(flag) {
  const i = process.argv.indexOf(flag)
  return i > -1 ? process.argv[i + 1] : undefined
}

function generatePassword() {
  // 18 bytes → 24 base64url chars. Plenty, and no ambiguous characters.
  return crypto.randomBytes(18).toString('base64url')
}

async function run() {
  const email = arg('--email')?.toLowerCase().trim()
  const name = arg('--name')?.trim() ?? 'Administrator'
  const provided = arg('--password')

  if (!email) {
    console.error('Usage: npm run seed:admin -- --email you@example.com [--name "Your Name"] [--password "..."]')
    process.exit(1)
  }
  if (provided && provided.length < 12) {
    console.error('Password must be at least 12 characters.')
    process.exit(1)
  }

  await connectDatabase()

  const existing = await User.findOne({ email })
  if (existing) {
    console.error(`\nA user with ${email} already exists (role: ${existing.role}).`)
    console.error('To reset their password, delete the user or add a password-reset flow.\n')
    await disconnectDatabase()
    process.exit(1)
  }

  const password = provided ?? generatePassword()

  const user = new User({
    email,
    name,
    role: 'ADMIN',
    accountType: 'B2C',
    status: 'ACTIVE',
    resolvedTier: 'B2C',
    isActive: true,
  })
  await user.setPassword(password)
  await user.save()

  console.log(`\n  Administrator created`)
  console.log(`  email:    ${email}`)
  if (!provided) {
    console.log(`  password: ${password}`)
    console.log(`\n  ^ Shown once. Save it now — it is not recoverable.\n`)
  }

  await disconnectDatabase()
}

run().catch(async (err) => {
  console.error(err)
  await disconnectDatabase().catch(() => {})
  process.exit(1)
})
