import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform"
import { BunRuntime } from "@effect/platform-bun"
import { Elysia } from "elysia"
import { Duration, Effect, Layer, Logger, Option } from "effect"

import { AppConfig, AppConfigLive } from "./config"
import { ContestDigestServiceLive } from "./services/contest-digest"
import { ContestCatalogServiceLive } from "./services/contest-sources"
import { DiscordBotService, DiscordBotServiceLive } from "./services/discord-bot"
import { ProfileSourceServiceLive } from "./services/profile-sources"
import { SchedulerService, SchedulerServiceLive } from "./services/scheduler"
import { StateStoreServiceLive } from "./services/state-store"

const infraLayer = Layer.mergeAll(AppConfigLive, FetchHttpClient.layer)
const stateStoreLayer = StateStoreServiceLive.pipe(Layer.provide(infraLayer))
const contestCatalogLayer = ContestCatalogServiceLive.pipe(Layer.provide(infraLayer))
const digestDependencies = Layer.mergeAll(infraLayer, contestCatalogLayer)
const digestLayer = ContestDigestServiceLive.pipe(Layer.provide(digestDependencies))
const profileLayer = ProfileSourceServiceLive.pipe(Layer.provide(infraLayer))
const botDependencies = Layer.mergeAll(infraLayer, stateStoreLayer, digestLayer, profileLayer)
const botLayer = DiscordBotServiceLive.pipe(Layer.provide(botDependencies))
const schedulerDependencies = Layer.mergeAll(botDependencies, botLayer)
const schedulerLayer = SchedulerServiceLive.pipe(Layer.provide(schedulerDependencies))

const appLayer = Layer.mergeAll(
  infraLayer,
  stateStoreLayer,
  contestCatalogLayer,
  digestLayer,
  profileLayer,
  botLayer,
  schedulerLayer
)

const startHttpServer = Effect.gen(function* () {
  const config = yield* AppConfig
  const bot = yield* DiscordBotService

  const app = new Elysia()
    .get("/health", () => ({
      ok: true,
      service: "contest-digest-bot",
      schedulerPollMinutes: config.schedulerPollMinutes,
      defaultTimeZone: config.defaultTimeZone
    }))
    .post("/api/webhooks/discord", ({ request }) =>
      Effect.runPromise(bot.handleWebhook(request))
    )

  yield* Effect.acquireRelease(
    Effect.sync(() => app.listen(config.port)),
    (runningApp) => Effect.promise(() => runningApp.stop()).pipe(Effect.catchAll(() => Effect.void))
  )

  yield* Effect.logInfo(`HTTP server listening on port ${config.port}`)
})

const startKeepAlive = Effect.gen(function* () {
  const config = yield* AppConfig
  const httpClient = yield* HttpClient.HttpClient

  if (Option.isNone(config.selfUsageUrl)) return

  const url = `${config.selfUsageUrl.value.replace(/\/$/, "")}/health`
  yield* Effect.logInfo(`Starting keep-alive ping loop for ${url}`)

  while (true) {
    yield* Effect.sleep(Duration.minutes(10))
    yield* HttpClientRequest.get(url).pipe(
      httpClient.execute,
      Effect.tap(() => Effect.logDebug(`Keep-alive ping sent to ${url}`)),
      Effect.catchAll((error) => Effect.logWarning(`Keep-alive ping failed: ${error}`))
    )
  }
})

const program = Effect.scoped(
  Effect.gen(function* () {
    const bot = yield* DiscordBotService
    const scheduler = yield* SchedulerService

    yield* startHttpServer
    yield* bot.registerCommands
    yield* Effect.logInfo("Discord slash commands registered")
    yield* Effect.forkScoped(scheduler.run)
    yield* Effect.forkScoped(startKeepAlive)
    yield* Effect.logInfo("Contest digest bot started")
    yield* Effect.never
  })
).pipe(
  Effect.provide(appLayer),
  (effect) =>
    Effect.flatMap(AppConfig, (config) =>
      Effect.provide(effect, Logger.minimumLogLevel(config.logLevel))
    ).pipe(Effect.provide(AppConfigLive))
)

BunRuntime.runMain(program)
