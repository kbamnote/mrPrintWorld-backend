/**
 * Seeds the three customer tiers.
 *
 * Idempotent — safe to re-run. Existing tiers are updated in place rather than
 * duplicated, and `code` is immutable so a re-run can never orphan the prices
 * that reference it.
 *
 *   npm run seed:tiers
 */

import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { CustomerTier } from '../src/models/CustomerTier.js'

const TIERS = [
  {
    code: 'B2C',
    name: 'Retail',
    description: 'Walk-up and online retail customers. The default for anonymous visitors.',
    order: 1,
    isDefault: true,
    // The ONLY tier whose prices may appear in an unauthenticated response.
    isPublic: true,
    requiresApproval: false,
  },
  {
    code: 'B2B',
    name: 'Business / Trade',
    description: 'Approved trade accounts. Requires an approved B2B application.',
    order: 2,
    isDefault: false,
    isPublic: false,
    requiresApproval: true,
  },
  {
    code: 'CORPORATE',
    name: 'Corporate',
    description: 'Approved corporate accounts, usually attached to an organization.',
    order: 3,
    isDefault: false,
    isPublic: false,
    requiresApproval: true,
  },
]

async function run() {
  await connectDatabase()

  for (const tier of TIERS) {
    const existing = await CustomerTier.findOne({ code: tier.code })
    if (existing) {
      // Never touch `code`; update the descriptive fields only.
      const { code: _code, ...rest } = tier
      Object.assign(existing, rest)
      await existing.save()
      console.log(`  updated  ${tier.code} — ${tier.name}`)
    } else {
      await CustomerTier.create(tier)
      console.log(`  created  ${tier.code} — ${tier.name}`)
    }
  }

  const all = await CustomerTier.find().sort({ order: 1 }).lean()
  console.log(`\n${all.length} tiers. Default: ${all.find((t) => t.isDefault)?.code ?? 'NONE'}`)
  console.log(`Public (price visible anonymously): ${all.filter((t) => t.isPublic).map((t) => t.code).join(', ')}`)

  await disconnectDatabase()
}

run().catch(async (err) => {
  console.error(err)
  await disconnectDatabase().catch(() => {})
  process.exit(1)
})
