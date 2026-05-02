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
import { DbServiceLive } from "./services/db"

const infraLayer = Layer.mergeAll(AppConfigLive, FetchHttpClient.layer)
const dbLayer = DbServiceLive.pipe(Layer.provide(infraLayer))
const contestCatalogLayer = ContestCatalogServiceLive.pipe(Layer.provide(infraLayer))
const digestLayer = ContestDigestServiceLive.pipe(Layer.provide(Layer.mergeAll(infraLayer, contestCatalogLayer)))
const profileLayer = ProfileSourceServiceLive.pipe(Layer.provide(infraLayer))
const botDependencies = Layer.mergeAll(infraLayer, dbLayer, digestLayer, profileLayer)
const botLayer = DiscordBotServiceLive.pipe(Layer.provide(botDependencies))
const schedulerLayer = SchedulerServiceLive.pipe(Layer.provide(Layer.mergeAll(botDependencies, botLayer)))

const appLayer = Layer.mergeAll(infraLayer, dbLayer, contestCatalogLayer, digestLayer, profileLayer, botLayer, schedulerLayer)

const startHttpServer = Effect.gen(function* () {
  const config = yield* AppConfig
  const bot = yield* DiscordBotService

  const app = new Elysia()
    .onRequest(({ request }) => {
      Effect.runPromise(Effect.logDebug(`[http] ${request.method} ${new URL(request.url).pathname}`))
    })
    .onAfterResponse(({ request, set }) => {
      const status = set.status ?? 200
      const path = new URL(request.url).pathname
      Effect.runPromise(
        typeof status === "number" && status >= 400
          ? Effect.logWarning(`[http] ${request.method} ${path}  ${status}`)
          : Effect.logInfo(`[http] ${request.method} ${path}  ${status}`)
      )
    })
    .get("/health", () => ({ ok: true, service: "tars", schedulerPollMinutes: config.schedulerPollMinutes, defaultTimeZone: config.defaultTimeZone }))
    .post("/api/webhooks/discord", ({ request }) => Effect.runPromise(bot.handleWebhook(request)))

  yield* Effect.acquireRelease(
    Effect.sync(() => app.listen(config.port)),
    (runningApp) => Effect.promise(() => runningApp.stop()).pipe(Effect.catchAll(() => Effect.void))
  )
  yield* Effect.logInfo(`[http] listening on port ${config.port}`)
})

const startKeepAlive = Effect.gen(function* () {
  const config = yield* AppConfig
  const httpClient = yield* HttpClient.HttpClient
  if (Option.isNone(config.selfUsageUrl)) return
  const url = `${config.selfUsageUrl.value.replace(/\/$/, "")}/health`
  yield* Effect.logInfo(`[keepalive] pinging ${url} every 10 minutes`)
  while (true) {
    yield* Effect.sleep(Duration.minutes(10))
    yield* HttpClientRequest.get(url).pipe(
      httpClient.execute,
      Effect.tap(() => Effect.logDebug(`[keepalive] ping sent`)),
      Effect.catchAll((error) => Effect.logWarning(`[keepalive] ping failed: ${error}`))
    )
  }
})

const program = Effect.scoped(
  Effect.gen(function* () {
    const bot = yield* DiscordBotService
    const scheduler = yield* SchedulerService
    yield* startHttpServer
    const config = yield* AppConfig
    if (!config.isDev) {
      yield* bot.registerCommands
      yield* Effect.logInfo("[bot] slash commands registered")
    } else {
      yield* Effect.logInfo("[bot] dev mode: skipping command registration")
    }
    yield* Effect.forkScoped(scheduler.run)
    yield* Effect.forkScoped(startKeepAlive)
    yield* Effect.forkScoped(bot.startGateway)
    yield* Effect.logInfo("[bot] started")
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
