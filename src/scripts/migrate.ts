/**
 * One-shot migration: Redis → SQLite
 * Idempotent — safe to re-run.
 * Usage: bun run src/scripts/migrate.ts
 */
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import Redis from "ioredis"

import { channelSubscriptions, commandChannels, ratingSnapshots, trackedHandles } from "../db/schema"

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"
const TURSO_URL = process.env.TURSO_DATABASE_URL ?? "file:./local.db"
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN ?? ""

const redis = new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: null })
const client = createClient({ url: TURSO_URL, ...(TURSO_TOKEN ? { authToken: TURSO_TOKEN } : {}) })
const db = drizzle({ client })

const isTrackingPlatform = (v: string): v is "codeforces" | "atcoder" =>
  v === "codeforces" || v === "atcoder"

async function main() {
  console.log("[migrate] applying schema migrations...")
  await migrate(db, { migrationsFolder: "./src/db/migrations" })
  console.log("[migrate] schema ready")

  // ── 1. Channel subscriptions ─────────────────────────────────────────────
  const channelIds = await redis.smembers("tars:subscriptions:index")
  console.log(`[migrate] found ${channelIds.length} subscriptions in Redis`)
  let subsMigrated = 0

  for (const channelId of channelIds) {
    const record = await redis.hgetall(`tars:subscription:${channelId}`)
    if (!record.guildId || !record.timezone) {
      console.warn(`[migrate] skipping subscription ${channelId}: missing required fields`)
      continue
    }
    await db.insert(channelSubscriptions).values({
      id: channelId,
      guildId: record.guildId,
      channelId,
      guildName: record.guildName || null,
      channelName: record.channelName || null,
      timezone: record.timezone,
      deliveryHour: Number(record.deliveryHour ?? 21),
      deliveryMinute: Number(record.deliveryMinute ?? 0),
      enabled: record.enabled === "true",
      createdByUserId: record.createdByUserId ?? "unknown",
      mentionRoleId: record.mentionRoleId || null,
      createdAt: record.createdAt ?? new Date().toISOString(),
      updatedAt: record.updatedAt ?? new Date().toISOString(),
    }).onConflictDoNothing()
    subsMigrated++
  }
  console.log(`[migrate] subscriptions migrated: ${subsMigrated}`)

  // ── 2. Tracked handles ───────────────────────────────────────────────────
  const trackedIds = await redis.smembers("tars:tracked:index")
  console.log(`[migrate] found ${trackedIds.length} tracked handles in Redis`)
  let handlesMigrated = 0

  for (const id of trackedIds) {
    const record = await redis.hgetall(`tars:tracked:meta:${id}`)
    if (!record.guildId || !record.platform || !record.handle) {
      console.warn(`[migrate] skipping tracked handle ${id}: missing required fields`)
      continue
    }
    if (!isTrackingPlatform(record.platform)) {
      console.warn(`[migrate] skipping tracked handle ${id}: unknown platform ${record.platform}`)
      continue
    }
    await db.insert(trackedHandles).values({
      id,
      guildId: record.guildId,
      platform: record.platform,
      handle: record.handle,
      handleNormalized: record.handleNormalized ?? record.handle.toLowerCase(),
      enabled: record.enabled !== "false",
      createdByUserId: record.createdByUserId ?? "unknown",
      createdAt: record.createdAt ?? new Date().toISOString(),
      updatedAt: record.updatedAt ?? new Date().toISOString(),
    }).onConflictDoNothing()
    handlesMigrated++

    // ── 3. Latest snapshot for this handle ──────────────────────────────────
    const snapshotRaw = await redis.get(`tars:snapshot:latest:${id}`)
    if (snapshotRaw) {
      try {
        const snap = JSON.parse(snapshotRaw) as {
          id?: string
          rating?: number | null
          rankLabel?: string | null
          maxRating?: number | null
          isImprovement?: boolean
          capturedAt?: string
          rawPayloadJson?: unknown
        }
        await db.insert(ratingSnapshots).values({
          id: snap.id ?? crypto.randomUUID(),
          trackedHandleId: id,
          rating: snap.rating ?? null,
          rankLabel: snap.rankLabel ?? null,
          maxRating: snap.maxRating ?? null,
          isImprovement: snap.isImprovement ?? false,
          capturedAt: snap.capturedAt ?? new Date().toISOString(),
          rawPayloadJson: JSON.stringify(snap.rawPayloadJson ?? {}),
        }).onConflictDoNothing()
      } catch (e) {
        console.warn(`[migrate] failed to parse snapshot for ${id}: ${e}`)
      }
    }
  }
  console.log(`[migrate] tracked handles migrated: ${handlesMigrated}`)

  // ── 4. Seed command channels from enabled subscriptions ──────────────────
  const allSubs = await db.select().from(channelSubscriptions)
  let channelsSeed = 0
  for (const sub of allSubs) {
    if (!sub.enabled) continue
    await db.insert(commandChannels).values({ guildId: sub.guildId, channelId: sub.channelId })
      .onConflictDoNothing()
    channelsSeed++
  }
  console.log(`[migrate] command channels seeded: ${channelsSeed}`)

  console.log("[migrate] done. Run src/scripts/flush-redis.ts to clear legacy Redis keys.")
}

main()
  .catch((e) => { console.error("[migrate] fatal:", e); process.exitCode = 1 })
  .finally(async () => { await redis.quit(); client.close() })
