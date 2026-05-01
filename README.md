# Contest Digest Bot

A professional, multi-tenant Discord bot built with **Bun** and **Effect-TS**. It provides daily contest digests (Codeforces & AtCoder) and real-time rating tracking for competitive programmers.

## 🚀 Features
- **Daily Digests:** Automatically posts upcoming contests for the next day.
- **Real-time Tracking:** Monitors Codeforces and AtCoder handles and congratulates users on rating improvements.
- **Multi-Tenant:** Each channel in each server can have its own independent timezone, delivery time, and tracked users.
- **Zero Configuration IDs:** All setup is done via slash commands; users never need to find raw Discord IDs.
- **Reliable Persistence:** Uses Redis to ensure digests are sent exactly once and tracking history is preserved.

---

## 🛠️ Setup & Local Development

### 1. Prerequisites
- **Bun:** Install via `curl -fsSL https://bun.sh/install | bash`.
- **Redis:** A running Redis instance (v5+).

### 2. Discord Configuration
1. Create an application on the [Discord Developer Portal](https://discord.com/developers/applications).
2. Go to the **Bot** tab and reset/copy your **Token**.
3. Go to **General Information** and copy your **Application ID** and **Public Key**.
4. Set the **Interactions Endpoint URL** to `https://<your-domain>/api/webhooks/discord`.

### 3. Environment
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

### 4. Running
```bash
bun install
bun run dev    # For development with hot-reload
bun run start  # For production
```

---

## 📦 Deployment (Render + Upstash)

### 1. Persistence (Upstash)
Since Render's free plan doesn't include Redis, use [Upstash](https://upstash.com/) for a free serverless Redis instance. Copy the `REDIS_URL`.

### 2. Web Service (Render)
1. Create a new **Web Service** on Render.
2. Build Command: `bun install`
3. Start Command: `bun run start`
4. Add all environment variables from your `.env` file.

### 💡 Keep-Alive (Important for Render Free Plan)
Render's free plan sleeps after 15 minutes of inactivity, which stops the scheduler.
**Fix:** The bot has a built-in Keep-Alive service. Just set the `SELF_USAGE_URL` environment variable to your app's public URL (e.g., `https://my-bot.onrender.com`). The bot will ping itself every 10 minutes to stay awake 24/7.

---

## 🎮 Commands

### Core Setup
- `/setup time:<HH:MM> timezone:<IANA zone>`: Enable digests in the current channel.
- `/settings`: Show channel config and tracked handles.
- `/disable`: Stop scheduled updates.
- `/timezone value:<IANA zone>`: Change only the timezone.
- `/time value:<HH:MM>`: Change only the delivery time.

### Contest Info
- `/today`: Contests remaining today.
- `/tomorrow`: Tomorrow's digest immediately.
- `/upcoming days:<number>`: Show contests for the next N days (default 7).
- `/next`: The very next upcoming contest.
- `/lucky`: Random fun contest pick from tomorrow's pool.
- `/test-digest`: Preview the scheduled digest format.

### Tracking & Leaderboard
- `/track-add platform:<...> handle:<...>`: Start tracking a user.
- `/track-remove platform:<...> handle:<...>`: Stop tracking a user.
- `/track-list`: List all tracked users in the channel.
- `/leaderboard`: **Show top 10 rated users in the channel.**
- `/rating platform:<...> handle:<...>`: Show current rating snapshot.
- `/compare platform:<...> handle_a:<...> handle_b:<...>`: Compare two users.
- `/streak platform:<...> handle:<...>`: Total recorded rating improvements.

---

## 🎨 UI Showcase

The bot uses modern, clean Markdown formatting with optimized spacing for high readability.

### Daily Digests (`/tomorrow`, `/today`, `/upcoming`)
```markdown
# Tomorrow's Contests
*Timezone: Asia/Dhaka*

## Codeforces

**[Codeforces Round 900 (Div. 2)](https://codeforces.com/contests/123)**
Time: `12:00 PM`  •  Duration: `2h 15m`

## AtCoder

**[AtCoder Beginner Contest 300](https://atcoder.jp/contests/abc300)**
Time: `05:00 PM`  •  Duration: `1h 40m`  •  Rated: `- 1999`
```

### Rating Improvements (Scheduler Announcement)
```markdown
# Codeforces Improvement

**tourist** just climbed from `3800` to **`3850`** (Legendary Grandmaster).
Delta: `+50` points

🔗 [View Profile](https://codeforces.com/profile/tourist)
```

### Leaderboard (`/leaderboard`)
```markdown
### Top 10 Leaderboard

**1.** `tourist` [Codeforces]: **3850** (Legendary Grandmaster)

**2.** `Benq` [Codeforces]: **3700** (Legendary Grandmaster)

**3.** `rng_58` [AtCoder]: **3200** (Red)
```

### Settings & Configuration (`/settings`)
```markdown
### Settings for #competitive-programming

Status: Active
Timezone: `Asia/Dhaka`
Delivery Time: `21:00`
Next Digest: <t:1710000000:R>

**Tracked Handles (2)**

• Codeforces: `tourist`
• AtCoder: `rng_58`
```

---

## 🧪 Testing
```bash
bun test        # Run all unit and integration tests
bun run typecheck  # Run TypeScript compiler checks
```
