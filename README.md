# Daily Goals

A personal goals and to-do app that:

- keeps checklists for **today, this week, this month, this year, and someday**;
- turns thoughts you **capture on the go** (typed, dictated, or via Siri) into tasks on the right horizon, and checks off things you say you finished, using Claude;
- **syncs two-way with Google Calendar**: events show up as checklist items, timed tasks are added to your calendar, and ticking a box on either side ticks it on the other;
- **syncs two-way with Planyway** (through Trello, where Planyway stores your schedule): dated cards and checklist items become checklist items for their day, tasks you create here become cards, and ticking a box on either side ticks it on the other;
- uses a plug-in **sync engine**, so checking something off in one place checks it off everywhere.

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

### Planyway (via Trello)

Planyway is a Trello Power-Up with no API of its own. What you schedule in it is saved on Trello cards (start and due dates) and checklist items (due dates), so the app syncs with Planyway through the Trello API.

| In Planyway / Trello | In Daily Goals |
|---|---|
| A card with a start or due date | A task on its start day (or due day). A block within one day, such as 10:00–11:30, keeps its time |
| A checklist item with a due date | Its own task on that day |
| Ticking the card's due date complete, or checking the item | The task is ticked, and the reverse also works |
| — | Tasks you create here (by typing or capturing a thought) become cards in the list you choose, with start and due set from the task's time |

Setup:

1. Go to <https://trello.com/power-ups/admin>, create a Power-Up (any name, for your workspace), and generate an **API key**.
2. Get a token by opening
   `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=Daily%20Goals&key=YOUR_KEY`
   and approving.
3. Put both in `.env` as `TRELLO_API_KEY` and `TRELLO_TOKEN`.
4. Optional settings:
   - `TRELLO_BOARD_IDS` limits sync to certain boards (the id is the part after `/b/` in a board's URL). It defaults to all your open boards.
   - `TRELLO_PUSH_LIST_ID` is the list where new tasks become cards. To find it, open any card in that list, add `.json` to the URL, and copy `idList`.
   - `TRELLO_ONLY_MINE=true` (the default) skips cards and checklist items assigned only to other people on shared boards.

Undated cards are left alone, so your backlog doesn't flood today's list.

### How syncing works with several apps

Items that come in from one app are **not** copied into another. Your Calendar meetings don't become Trello cards, and your Planyway cards aren't added to Google Calendar a second time (Planyway can do that itself). Only tasks created in Daily Goals are pushed out. When the same item exists in both apps (same title, same day), it's linked to one task, and ticking it anywhere ticks it everywhere.

### Adding another app

Each external app is a `SyncProvider` (`server/src/sync/provider.ts`) with five methods: `pull`, `setDone`, `shouldPush`, `create`, and `isConfigured`. Implement them and register the provider in `server/src/index.ts`. `server/src/sync/trello.ts` is a compact example. The engine (`server/src/sync/engine.ts`) handles importing, de-duplication, the three-way merge of completion state, and skipping pushes to an app whose pull just failed.

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
