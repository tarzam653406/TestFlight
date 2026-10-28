import { Store } from "./db.ts";
import { createApp } from "./app.ts";
import { ClaudePlanner } from "./planner.ts";
import { SyncEngine } from "./sync/engine.ts";
import { GoogleCalendarProvider, type PushMode } from "./sync/google-calendar.ts";
import type { SyncProvider } from "./sync/provider.ts";

const env = process.env;
const port = Number(env.PORT ?? 8787);
const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const timeZone = env.TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const appToken = env.APP_TOKEN ?? "";
if (appToken.length < 16) {
  console.error("Set APP_TOKEN to a random string of at least 16 characters (see .env.example).");
  process.exit(1);
}

const store = new Store(env.DB_PATH ?? "data/goals.db");

const google = new GoogleCalendarProvider(store, {
  clientId: env.GOOGLE_CLIENT_ID ?? "",
  clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
  redirectUri: `${publicUrl}/auth/google/callback`,
  calendarId: env.GOOGLE_CALENDAR_ID ?? "primary",
  timeZone,
  pushMode: (env.GOOGLE_PUSH_TASKS as PushMode | undefined) ?? "timed",
});

// Register more providers (e.g. your planner app) here.
const providers: SyncProvider[] = [google];
const sync = new SyncEngine(store, providers, timeZone);

const planner = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? new ClaudePlanner() : null;
if (!planner) console.warn("ANTHROPIC_API_KEY is not set; captured thoughts will be saved but not processed.");

const app = createApp({ store, planner, sync, google, appToken, timeZone });
app.listen(port, () => {
  console.log(`Daily Goals listening on ${publicUrl} (timezone ${timeZone})`);
});

const intervalMs = Math.max(1, Number(env.SYNC_INTERVAL_MINUTES ?? 5)) * 60_000;
const runSync = () =>
  sync
    .sync()
    .then((r) => {
      for (const p of r.providers) if (p.errors.length) console.warn(`[sync ${p.provider}]`, p.errors.join("; "));
    })
    .catch((e) => console.error("sync failed", e));
setInterval(runSync, intervalMs);
void runSync();
