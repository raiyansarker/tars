# TARS - Discord Contest Bot

[![Better Stack Badge](https://uptime.betterstack.com/status-badges/v1/monitor/2la8v.svg)](https://uptime.betterstack.com/?utm_source=status_badge)

A multi-tenant Discord bot built with **Bun** and **Effect-TS**. Provides daily contest digests, real-time rating tracking, and AI-powered features for competitive programmers.

## Features

- **Daily Digests:** Automatically posts upcoming Codeforces & AtCoder contests each day.
- **Rating Tracking:** Monitors handles and announces improvements with AI-generated motivational quotes.
- **Random Problems:** `/random` picks a Codeforces problem suited to your current rating.
- **AI Excuses:** `!oops` generates a deadpan excuse for why you're not competing today.
- **Multi-Tenant:** Each channel has its own timezone, delivery time, and tracked handles.
- **Persistent:** Uses Redis for exactly-once digest delivery and tracking history.

---

## Setup & Local Development

### Prerequisites
- **Bun:** `curl -fsSL https://bun.sh/install | bash`
- **Redis:** A running Redis instance (v5+)

### Discord Configuration
1. Create an application on the [Discord Developer Portal](https://discord.com/developers/applications).
2. Go to **Bot** → reset/copy your **Token**.
3. Go to **General Information** → copy **Application ID** and **Public Key**.
4. Set **Interactions Endpoint URL** to `https://<your-domain>/api/webhooks/discord`.
5. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.

### Environment
```bash
cp .env.example .env
# Fill in DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID, REDIS_URL, GROQ_API_KEY
```

### Running
```bash
bun install
bun run dev    # Development with hot-reload
bun run start  # Production
```

---

## Deployment

- **Build Command:** `bun install`
- **Start Command:** `bun run start`
- Add all variables from `.env.example` to your hosting environment.

**Keep-Alive:** Set `SELF_USAGE_URL` to your app's public URL to ping `/health` every 10 minutes and prevent sleep on free-tier hosts.

---

## Commands

### Setup *(admin only)*
| Command | Description |
|---|---|
| `/setup time:<HH:MM> timezone:<IANA>` | Enable digests in this channel |
| `/disable` | Stop scheduled digests |
| `/time value:<HH:MM>` | Change delivery time |
| `/timezone value:<IANA>` | Change timezone |
| `/test-digest` | Preview tomorrow's digest |

### Info
| Command | Description |
|---|---|
| `/status` | Digest schedule and service status |
| `/today` | Contests happening today |
| `/tomorrow` | Tomorrow's contests |
| `/upcoming days:<n>` | Contests over the next N days (default 7) |
| `/next` | The very next upcoming contest |
| `/lucky` | Random contest pick from tomorrow's pool |

### Tracking
| Command | Description |
|---|---|
| `/track-add platform:<...> handle:<...>` | Start tracking a handle |
| `/track-remove platform:<...> handle:<...>` | Stop tracking a handle |
| `/track-list` | List tracked handles in this channel |
| `/leaderboard` | Top 10 rated users in this channel |
| `/rating platform:<...> handle:<...>` | Current rating for a handle |
| `/compare platform:<...> handle_a:<...> handle_b:<...>` | Compare two handles |
| `/streak platform:<...> handle:<...>` | Recorded rating improvements for a handle |
| `/random` | Random Codeforces problem at your rating |

### Fun
| Command | Description |
|---|---|
| `!oops` | AI-generated excuse for not competing today |

---

## Testing
```bash
bun test
bun run typecheck
```
