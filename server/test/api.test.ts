import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { todayIn } from "../src/dates.ts";
import { Store } from "../src/db.ts";
import type { PlannerLLM } from "../src/planner.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { localPlusMinutes } from "../src/sync/google-calendar.ts";

const TOKEN = "test-token-0123456789";
const TZ = "UTC";
let server: Server;
let base: string;
let lastToday = "";

const planner: PlannerLLM = {
  async plan({ text, today }) {
    lastToday = today;
    return {
      summary: "ok",
      operations: [{ action: "create", taskId: "", title: text, notes: "", horizon: "week", date: today, startTime: "", durationMinutes: 0, reason: "" }],
    };
  },
};

beforeAll(async () => {
  const store = new Store(":memory:");
  const app = createApp({ store, planner, sync: new SyncEngine(store, [], TZ), google: null, appToken: TOKEN, timeZone: TZ });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const call = (path: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
  });

describe("API", () => {
  it("rejects requests without the app token", async () => {
    expect((await call("/api/agenda", {}, "wrong")).status).toBe(401);
  });

  it("creates, ticks and lists tasks in the agenda", async () => {
    const created = await call("/api/tasks", { method: "POST", body: JSON.stringify({ title: "Stretch", startTime: "07:30" }) });
    expect(created.status).toBe(201);
    const task = await created.json();
    const patched = await call(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ done: true }) });
    expect((await patched.json()).done).toBe(true);
    const agenda = await (await call("/api/agenda")).json();
    expect(agenda.date).toBe(todayIn(TZ));
    expect(agenda.day.map((t: { title: string }) => t.title)).toContain("Stretch");
  });

  it("validates input", async () => {
    const res = await call("/api/tasks", { method: "POST", body: JSON.stringify({ title: "", horizon: "decade" }) });
    expect(res.status).toBe(400);
  });

  it("processes a capture and uses the capture time for an offline-queued thought", async () => {
    const res = await call("/api/captures", {
      method: "POST",
      body: JSON.stringify({ text: "Plan team offsite", capturedAt: "2026-01-15T10:00:00Z" }),
    });
    expect(res.status).toBe(200);
    expect(lastToday).toBe("2026-01-15");
    const agenda = await (await call("/api/agenda?date=2026-01-15")).json();
    expect(agenda.week.map((t: { title: string }) => t.title)).toEqual(["Plan team offsite"]);
  });
});

describe("calendar time math", () => {
  it("adds minutes across midnight", () => {
    expect(localPlusMinutes("2026-10-28", "23:45", 30)).toBe("2026-10-29T00:15:00");
  });
});
