import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const channelSubscriptions = sqliteTable(
  "channel_subscriptions",
  {
    id: text("id").primaryKey(), // channelId
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull().unique(),
    guildName: text("guild_name"),
    channelName: text("channel_name"),
    timezone: text("timezone").notNull(),
    deliveryHour: integer("delivery_hour").notNull(),
    deliveryMinute: integer("delivery_minute").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdByUserId: text("created_by_user_id").notNull(),
    mentionRoleId: text("mention_role_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_channel_subscriptions_guild").on(t.guildId)]
)

export const trackedHandles = sqliteTable(
  "tracked_handles",
  {
    id: text("id").primaryKey(), // "{guildId}:{platform}:{handleNormalized}"
    guildId: text("guild_id").notNull(),
    platform: text("platform").notNull(),
    handle: text("handle").notNull(),
    handleNormalized: text("handle_normalized").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_tracked_handles_guild").on(t.guildId)]
)

export const ratingSnapshots = sqliteTable(
  "rating_snapshots",
  {
    id: text("id").primaryKey(),
    trackedHandleId: text("tracked_handle_id")
      .notNull()
      .references(() => trackedHandles.id),
    rating: integer("rating"),
    rankLabel: text("rank_label"),
    maxRating: integer("max_rating"),
    isImprovement: integer("is_improvement", { mode: "boolean" }).notNull().default(false),
    capturedAt: text("captured_at").notNull(),
    rawPayloadJson: text("raw_payload_json").notNull(),
  },
  (t) => [index("idx_rating_snapshots_handle").on(t.trackedHandleId)]
)

export const commandChannels = sqliteTable("command_channels", {
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
}, (t) => [primaryKey({ columns: [t.guildId, t.channelId] })])
