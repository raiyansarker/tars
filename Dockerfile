FROM oven/bun:1.3.11-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS release
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "src/index.ts"]
