import mongoose from 'mongoose'
import { env, assertNamedDatabase } from './env.js'

/**
 * Mongoose connection. Called once from server.js before the HTTP listener
 * opens, so the process never accepts traffic it cannot serve.
 */
export async function connectDatabase() {
  const dbName = assertNamedDatabase()

  // Reject unknown fields rather than silently discarding them — a typo in a
  // field name should surface as an error, not as data that vanishes.
  mongoose.set('strictQuery', true)

  mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err.message)
  })
  mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB disconnected')
  })

  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    autoIndex: !env.isProd, // build indexes in dev; do it deliberately in prod
  })

  console.log(`MongoDB connected → ${dbName ?? '(default db)'}`)
  return mongoose.connection
}

export async function disconnectDatabase() {
  await mongoose.connection.close()
}
