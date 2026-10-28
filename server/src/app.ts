import express, { type NextFunction, type Request, type Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HORIZONS, isIsoDate, periodStart, periodsContaining, todayIn, type Horizon } from "./dates.ts";
import type { Store, Task } from "./db.ts";
import { processCapture, type PlannerLLM } from "./planner.ts";
import type { SyncEngine } from "./sync/engine.ts";
import type { GoogleCalendarProvider } from "./sync/google-calendar.ts";

export interface AppDeps {
  store: Store;
  planner: PlannerLLM | null;
  sync: SyncEngine;
  google: GoogleCalendarProvider | null;
  appToken: string;
  timeZone: string;
}

const publicDir = fileURLToPath(new URL("../public", import.meta.url));

const isoDate = z.string().refine(isIsoDate, "expected YYYY-MM-DD");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");
const horizon = z.enum(HORIZONS as [Horizon, ...Horizon[]]);

const NewTaskBody = z.object({
  title: z.string().trim().min(1).max(500),
  notes: z.string().max(5000).optional(),
  horizon: horizon.default("day"),
  date: isoDate.optional(),
  startTime: hhmm.nullable().optional(),
  durationMinutes: z.number().int().positive().nullable().optional(),
});

const PatchTaskBody = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  notes: z.string().max(5000).optional(),
  done: z.boolean().optional(),
  horizon: horizon.optional(),
  date: isoDate.optional(),
  startTime: hhmm.nullable().optional(),
  durationMinutes: z.number().int().positive().nullable().optional(),
});

const CaptureBody = z.object({
  text: z.string().trim().min(1).max(20_000),
  /** Set by clients that queued the thought offline. */
  capturedAt: z.iso.datetime({ offset: true }).optional(),
});

export function createApp(deps: AppDeps): express.Express {
  const { store, sync, google, timeZone } = deps;
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const requireToken = (req: Request, res: Response, next: NextFunction) => {
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!safeEqual(token, deps.appToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  // Ticking a box should reach other apps quickly, without waiting for the interval.
  let syncTimer: NodeJS.Timeout | null = null;
  const syncSoon = () => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      sync.sync().catch((e) => console.error("sync failed", e));
    }, 3_000);
    syncTimer.unref();
  };

  const withLinks = (t: Task) => ({ ...t, linkedTo: store.linksForTask(t.id).map((l) => l.provider) });

  const api = express.Router();
  api.use(requireToken);

  api.get("/agenda", (req, res) => {
    const date = typeof req.query.date === "string" && isIsoDate(req.query.date) ? req.query.date : todayIn(timeZone);
    const periods = periodsContaining(date);
    res.json({
      date,
      today: todayIn(timeZone),
      periods,
      day: store.tasksInPeriod("day", periods.day).map(withLinks),
      week: store.tasksInPeriod("week", periods.week).map(withLinks),
      month: store.tasksInPeriod("month", periods.month).map(withLinks),
      year: store.tasksInPeriod("year", periods.year).map(withLinks),
      someday: store.tasksInPeriod("someday", null).map(withLinks),
      overdue: store.overdue(periods).map(withLinks),
    });
  });

  api.post("/tasks", (req, res) => {
    const body = NewTaskBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: z.prettifyError(body.error) });
      return;
    }
    const b = body.data;
    const task = store.createTask({
      title: b.title,
      notes: b.notes,
      horizon: b.horizon,
      periodStart: periodStart(b.horizon, b.date ?? todayIn(timeZone)),
      startTime: b.horizon === "day" ? (b.startTime ?? null) : null,
      durationMinutes: b.durationMinutes ?? null,
      source: "app",
    });
    syncSoon();
    res.status(201).json(withLinks(task));
  });

  api.patch("/tasks/:id", (req, res) => {
    const body = PatchTaskBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: z.prettifyError(body.error) });
      return;
    }
    const existing = store.getTask(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const { date, ...rest } = body.data;
    const h = rest.horizon ?? existing.horizon;
    const patch = {
      ...rest,
      ...(date || rest.horizon ? { periodStart: periodStart(h, date ?? existing.periodStart ?? todayIn(timeZone)) } : {}),
      // Only day tasks have a time of day.
      ...(h !== "day" ? { startTime: null, durationMinutes: null } : {}),
    };
    const task = store.updateTask(existing.id, patch)!;
    syncSoon();
    res.json(withLinks(task));
  });

  api.delete("/tasks/:id", (req, res) => {
    res.status(store.deleteTask(req.params.id) ? 204 : 404).end();
  });

  api.post("/captures", async (req, res) => {
    const body = CaptureBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: z.prettifyError(body.error) });
      return;
    }
    if (!deps.planner) {
      store.createCapture(body.data.text);
      res.status(503).json({ error: "Claude is not configured (set ANTHROPIC_API_KEY). The thought was saved." });
      return;
    }
    const capturedAt = body.data.capturedAt ? new Date(body.data.capturedAt) : new Date();
    try {
      const result = await processCapture(store, deps.planner, body.data.text, todayIn(timeZone, capturedAt));
      syncSoon();
      res.json(result);
    } catch (e) {
      console.error("capture failed", e);
      res.status(502).json({ error: e instanceof Error ? e.message : "failed to process thought" });
    }
  });

  api.get("/captures", (_req, res) => {
    res.json(store.recentCaptures().map((c) => ({ ...c, result: c.result ? JSON.parse(c.result) : null })));
  });

  api.get("/sync", (_req, res) => {
    res.json({
      providers: sync.configuredProviders().map((p) => p.name),
      google: google ? { available: google.hasClientCredentials(), connected: google.isConfigured() } : null,
      last: sync.lastReport,
    });
  });

  api.post("/sync", async (_req, res) => {
    res.json(await sync.sync());
  });

  // Starting OAuth is a browser navigation, so the client first asks for a one-time
  // URL with its bearer token, then opens it.
  const oauthStates = new Map<string, number>();
  api.post("/google/connect", (_req, res) => {
    if (!google?.hasClientCredentials()) {
      res.status(400).json({ error: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first." });
      return;
    }
    const state = randomBytes(16).toString("hex");
    oauthStates.set(state, Date.now() + 10 * 60_000);
    res.json({ url: google.authUrl(state) });
  });

  api.post("/google/disconnect", (_req, res) => {
    google?.disconnect();
    res.status(204).end();
  });

  app.get("/auth/google/callback", async (req, res) => {
    const state = String(req.query.state ?? "");
    const expires = oauthStates.get(state);
    oauthStates.delete(state);
    if (!google || !expires || expires < Date.now() || typeof req.query.code !== "string") {
      res.status(400).send("Invalid or expired sign-in attempt. Start again from the app.");
      return;
    }
    try {
      await google.handleCallback(req.query.code);
      syncSoon();
      res.redirect("/?google=connected");
    } catch (e) {
      console.error("google oauth failed", e);
      res.status(502).send("Google sign-in failed.");
    }
  });

  app.use("/api", api);
  app.use(express.static(publicDir));
  return app;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
