export type ContestPlatform = "Codeforces" | "AtCoder"

export interface Contest {
  readonly id: string
  readonly platform: ContestPlatform
  readonly title: string
  readonly url: string
  readonly startAt: Date
  readonly durationMinutes: number
  readonly ratedRange?: string
  readonly contestType?: string
  readonly registrationUrl?: string
}

export interface ContestDigest {
  readonly targetDateKey: string
  readonly contests: ReadonlyArray<Contest>
  readonly message: string
}
