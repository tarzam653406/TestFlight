# Daily Goals

A personal goals and to-do app that:

- keeps checklists for **today, this week, this month, this year, and someday**;
- turns thoughts you **capture on the go** (typed, dictated, or via Siri) into tasks on the right horizon, and checks off things you say you finished, using Claude;
- **syncs two-way with Google Calendar**: events show up as checklist items, timed tasks are added to your calendar, and ticking a box on either side ticks it on the other;
- has a plug-in **sync engine** for other planner apps, so checking something off in one place checks it off everywhere.

```
server/   Node + TypeScript API, sync engine, Claude planner, and the web app (PWA)
ios/      SwiftUI iPhone client (for TestFlight) that talks to the same server
```

## How a captured thought is processed

You say: *"Finished the budget review. Call the plumber tomorrow at 9, and sometime next month I need to book the car service. This year I want to run a half marathon."*

Claude receives the thought, today's date, and your open tasks. It returns a plan, which the server applies:

| Operation | Result |
|---|---|
| complete | ✅ "Review budget" (matched to the existing open task) |
| create | "Call the plumber" → tomorrow at 09:00, pushed to Google Calendar |
| create | "Book car service" → next month's list |
| create | "Run a half marathon" → this year's list |

Thoughts captured offline are queued on the device and processed later, relative to the time you captured them, so "tomorrow" still means the right day.

## Running the server

Requirements: Node.js 22.13 or later.

```bash
cd server
npm install
cp .env.example .env      # then fill in APP_TOKEN, TIMEZONE, ANTHROPIC_API_KEY
npm start                 # http://localhost:8787
npm test                  # unit + API tests
```

Open the URL, enter your `APP_TOKEN`, and you're in. On your phone, use **Share → Add to Home Screen** to install it like an app. The mic button uses the browser's speech recognition.

To reach the app from your phone, host the server somewhere reachable (Fly.io, Render, Railway, a home server behind Tailscale, …) and set `PUBLIC_URL`. Data lives in a single SQLite file (`server/data/goals.db`), so give the host a persistent volume.

### Google Calendar

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Calendar API**.
2. Configure the OAuth consent screen (External, and add yourself as a test user).
3. Create an **OAuth client ID** of type *Web application* with the authorized redirect URI `PUBLIC_URL/auth/google/callback`.
4. Put the client ID and secret in `.env`, restart, then open **Settings → Google Calendar → Connect** in the web app.

`GOOGLE_PUSH_TASKS` decides which of your tasks are written to the calendar: `timed` (default; only tasks with a time), `all` (also adds untimed day tasks as all-day events), or `none`. Completed events get a `✓ ` prefix in Google Calendar. Adding or removing that prefix in Calendar ticks or unticks the item in the app.

### Adding another planner app (e.g. "Planaway")

Each external app is a `SyncProvider` (`server/src/sync/provider.ts`) with five methods: `pull`, `setDone`, `shouldPush`, `create`, and `isConfigured`. Implement them against the app's API and register the provider in `server/src/index.ts`. The engine (`server/src/sync/engine.ts`) then takes care of:

- importing the app's items into the right day,
- de-duplicating an item that arrives from two apps (same title, same day),
- a three-way merge of completion state, so a box ticked anywhere is ticked everywhere in a single sync run,
- never pushing to an app whose pull just failed.

Sync runs every `SYNC_INTERVAL_MINUTES`, a few seconds after you change something, and on demand (pull-to-refresh on iOS, or **Sync now**).

## iOS app (TestFlight)

The SwiftUI client in `ios/` needs Xcode 15 or later and iOS 17 or later.

```bash
brew install xcodegen
cd ios && xcodegen        # creates DailyGoals.xcodeproj
open DailyGoals.xcodeproj
```

1. Set your team and change `PRODUCT_BUNDLE_IDENTIFIER` in `project.yml` (then run `xcodegen` again).
2. Run on your phone, open Settings, and enter the server URL and app token.
3. For TestFlight, choose **Product → Archive → Distribute App → TestFlight & App Store**.

Features include the agenda with swipe-to-complete and swipe-to-tomorrow, on-device dictation in the capture box, an offline queue, and a **Capture Thought** Siri / Shortcuts action. Say *"Hey Siri, capture a thought in Daily Goals"*, or assign it to the Action button.
