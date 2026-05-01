export type TrackingPlatform = "codeforces" | "atcoder"

export interface ChannelSubscription {
  readonly id: string
  readonly guildId: string
  readonly channelId: string
  readonly guildName: string | null
  readonly channelName: string | null
  readonly timezone: string
  readonly deliveryHour: number
  readonly deliveryMinute: number
  readonly enabled: boolean
  readonly createdByUserId: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface TrackedHandle {
  readonly id: string
  readonly channelSubscriptionId: string
  readonly platform: TrackingPlatform
  readonly handle: string
  readonly handleNormalized: string
  readonly enabled: boolean
  readonly createdByUserId: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface SchedulerTrackedHandle extends ChannelSubscription {
  readonly trackedHandleId: string
  readonly platform: TrackingPlatform
  readonly handle: string
  readonly handleNormalized: string
  readonly handleCreatedByUserId: string
}

export interface RatingSnapshot {
  readonly id: string
  readonly trackedHandleId: string
  readonly rating: number | null
  readonly rankLabel: string | null
  readonly maxRating: number | null
  readonly isImprovement: boolean
  readonly capturedAt: Date
  readonly rawPayloadJson: unknown
}

export interface TrackedProfile {
  readonly platform: TrackingPlatform
  readonly handle: string
  readonly handleNormalized: string
  readonly profileUrl: string
  readonly rating: number | null
  readonly rankLabel: string | null
  readonly maxRating: number | null
  readonly rawPayload: unknown
}
