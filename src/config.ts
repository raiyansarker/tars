import { Context, Config, ConfigProvider, Effect, Layer, LogLevel, Option } from "effect"

export interface AppConfig {
  readonly discordBotToken: string
  readonly discordPublicKey: string
  readonly discordApplicationId: string
  readonly redisUrl: string
  readonly tursoUrl: string
  readonly tursoAuthToken: string
  readonly botUserName: string
  readonly port: number
  readonly defaultTimeZone: string
  readonly defaultDeliveryHour: number
  readonly defaultDeliveryMinute: number
  readonly schedulerPollMinutes: number
  readonly contestCacheTtlSeconds: number
  readonly logLevel: LogLevel.LogLevel
  readonly selfUsageUrl: Option.Option<string>
  readonly groqApiKey: string
  readonly isDev: boolean
}

export const AppConfig = Context.GenericTag<AppConfig>("AppConfig")

const AppConfigSource = Config.all({
  discordBotToken: Config.string("DISCORD_BOT_TOKEN"),
  discordPublicKey: Config.string("DISCORD_PUBLIC_KEY"),
  discordApplicationId: Config.string("DISCORD_APPLICATION_ID"),
  redisUrl: Config.string("REDIS_URL"),
  tursoUrl: Config.string("TURSO_DATABASE_URL"),
  tursoAuthToken: Config.string("TURSO_AUTH_TOKEN").pipe(Config.withDefault("")),
  botUserName: Config.string("BOT_USER_NAME").pipe(Config.withDefault("tars")),
  port: Config.integer("PORT").pipe(Config.withDefault(3000)),
  defaultTimeZone: Config.string("DEFAULT_TIMEZONE").pipe(
    Config.withDefault("Asia/Dhaka")
  ),
  defaultDeliveryHour: Config.integer("DEFAULT_DELIVERY_HOUR").pipe(
    Config.withDefault(21)
  ),
  defaultDeliveryMinute: Config.integer("DEFAULT_DELIVERY_MINUTE").pipe(
    Config.withDefault(0)
  ),
  schedulerPollMinutes: Config.integer("SCHEDULER_POLL_MINUTES").pipe(
    Config.withDefault(10)
  ),
  contestCacheTtlSeconds: Config.integer("CONTEST_CACHE_TTL_SECONDS").pipe(
    Config.withDefault(300)
  ),
  selfUsageUrl: Config.string("SELF_USAGE_URL").pipe(Config.option),
  groqApiKey: Config.string("GROQ_API_KEY"),
  isDev: Config.string("NODE_ENV").pipe(
    Config.withDefault("production"),
    Config.map((v) => v === "development")
  ),
  logLevel: Config.string("LOG_LEVEL").pipe(
    Config.withDefault("INFO"),
    Config.map((level) => {
      switch (level.toUpperCase()) {
        case "ALL": return LogLevel.All
        case "DEBUG": return LogLevel.Debug
        case "INFO": return LogLevel.Info
        case "WARNING": return LogLevel.Warning
        case "ERROR": return LogLevel.Error
        case "FATAL": return LogLevel.Fatal
        case "NONE": return LogLevel.None
        default: return LogLevel.Info
      }
    })
  )
})

export const AppConfigLive = Layer.effect(
  AppConfig,
  AppConfigSource.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv()))
)
