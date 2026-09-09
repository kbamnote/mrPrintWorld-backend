import { createApp } from './app.js'
import { env } from './config/env.js'
import { connectDatabase, disconnectDatabase } from './config/db.js'

async function start() {
  // Connect BEFORE listening, so the process never accepts a request it
  // cannot serve — a health check that passes while the database is down is
  // worse than one that fails.
  await connectDatabase()

  const app = createApp()
  const server = app.listen(env.PORT, () => {
    console.log(`MRPrint World API → http://localhost:${env.PORT} [${env.NODE_ENV}]`)
    console.log(`CORS allowlist: ${env.corsOrigins.join(', ')}`)
  })

  const shutdown = async (signal) => {
    console.log(`\n${signal} received — shutting down`)
    server.close(async () => {
      await disconnectDatabase()
      process.exit(0)
    })
    // Do not hang for ever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

start().catch((err) => {
  console.error('Failed to start:', err)
  process.exit(1)
})
