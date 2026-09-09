/**
 * Environment configuration, validated once at boot.
 *
 * The process refuses to start if anything required is missing or malformed.
 * A backend that boots with a missing JWT secret and only fails on the first
 * login is far worse than one that refuses to start at all.
 */

import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  // Mongo. The database name MUST be explicit in the URI — relying on the
  // driver default lands you in the shared `test` database on a shared Atlas
  // cluster, which is a collision that has bitten this team before.
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  // Auth. Two distinct secrets so a leaked access token can never be replayed
  // as a refresh token.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >= 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >= 32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),

  // Comma-separated origin allowlist. No wildcard in production.
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5185'),

  // Cloudinary — optional at boot so the API runs before credentials exist.
  // The upload route checks `isCloudinaryConfigured` and 503s cleanly instead
  // of throwing an unhandled error deep inside the SDK.
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('mrprintworld/products'),

  // Payments — optional at boot so the API runs before Razorpay is set up.
  // Checkout returns a clear 503 until these exist, rather than throwing
  // somewhere inside the SDK.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n')
  console.error(`\nInvalid environment configuration:\n${issues}\n`)
  console.error('Copy .env.example to .env and fill in the values.\n')
  process.exit(1)
}

const raw = parsed.data

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isDev: raw.NODE_ENV === 'development',
  corsOrigins: raw.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
}

export const isCloudinaryConfigured = Boolean(
  raw.CLOUDINARY_CLOUD_NAME && raw.CLOUDINARY_API_KEY && raw.CLOUDINARY_API_SECRET,
)

/** Warn loudly about a URI with no explicit database name. */
export function assertNamedDatabase() {
  // mongodb+srv://user:pass@host/<dbname>?opts   ← we want <dbname> non-empty
  const afterHost = raw.MONGODB_URI.split('://')[1]?.split('/').slice(1).join('/') ?? ''
  const dbName = afterHost.split('?')[0]
  if (!dbName) {
    console.warn(
      '\n⚠  MONGODB_URI has no database name — Mongo will use the default `test` db.\n' +
        '   Add one:  ...mongodb.net/mrpw_catalogue?retryWrites=true\n',
    )
  }
  return dbName || null
}
