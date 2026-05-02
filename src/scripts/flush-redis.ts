/**
 * Flush legacy Redis keys after Redis → SQLite migration.
 * Run AFTER migrate.ts has completed successfully.
 * Usage: bun run src/scripts/flush-redis.ts
 */
import Redis from "ioredis"

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  lazyConnect: false,
  maxRetriesPerRequest: null,
})

async function main() {
  // Legacy source-of-truth keys (now in SQLite)
  const patterns = [
    "tars:subscription:*",
    "tars:subscriptions:index",
    "tars:tracked:meta:*",
    "tars:tracked:guild:*",
    "tars:tracked:index",
    "tars:snapshot:history:*",
    "tars:snapshot:improvement-count:*",
  ]

  let total = 0
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern)
    if (keys.length > 0) {
      await redis.del(...keys)
      console.log(`[flush] deleted ${keys.length} keys matching ${pattern}`)
      total += keys.length
    } else {
      console.log(`[flush] no keys matching ${pattern}`)
    }
  }

  // Cache keys — also safe to flush (will repopulate from SQLite on next read)
  const cachePatterns = ["tars:subscriptions:enabled", "tars:snapshot:latest:*"]
  for (const pattern of cachePatterns) {
    const keys = await redis.keys(pattern)
    if (keys.length > 0) {
      await redis.del(...keys)
      console.log(`[flush] deleted ${keys.length} cache keys matching ${pattern}`)
      total += keys.length
    }
  }

  console.log(`[flush] done. ${total} keys deleted.`)
}

main()
  .catch((e) => { console.error("[flush] fatal:", e); process.exitCode = 1 })
  .finally(async () => { await redis.quit() })
