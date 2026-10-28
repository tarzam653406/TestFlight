import { describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { TrelloProvider, zonedToUtc, type TrelloOptions } from "../src/sync/trello.ts";
import { todayIn } from "../src/dates.ts";

const TZ = "America/New_York";

/** A tiny in-memory Trello that records every request. */
function fakeTrello(cards: Record<string, unknown>[]) {
  const calls: { method: string; path: string; params: URLSearchParams }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/1/, "");
    calls.push({ method, path, params: url.searchParams });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (path === "/members/me") return json({ id: "me" });
    if (path === "/members/me/boards") return json([{ id: "b1" }]);
    if (path === "/boards/b1/cards") return json(cards);
    if (method === "POST" && path === "/cards") return json({ id: "new1" });
    const card = path.match(/^\/cards\/([^/]+)/)?.[1];
    if (card === "gone") return new Response("not found", { status: 404 });
    return json({});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const opts = (fetchImpl: typeof fetch, extra: Partial<TrelloOptions> = {}): TrelloOptions => ({
  apiKey: "k",
  token: "t",
  boardIds: [],
  pushListId: "",
  pushMode: "all",
  onlyMine: true,
  timeZone: TZ,
  fetch: fetchImpl,
  ...extra,
});

const today = todayIn(TZ);
const at = (time: string) => zonedToUtc(today, time, TZ).toISOString();

describe("TrelloProvider (Planyway)", () => {
  it("converts local wall-clock times to UTC across DST", () => {
    expect(zonedToUtc("2026-07-01", "09:00", TZ).toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedToUtc("2026-12-01", "09:00", TZ).toISOString()).toBe("2026-12-01T14:00:00.000Z");
  });

  it("reads dated cards and checklist items that are yours", async () => {
    const { fetchImpl } = fakeTrello([
      { id: "c1", name: "Design review", start: at("10:00"), due: at("11:30"), dueComplete: false, idMembers: [], checklists: [] },
      { id: "c2", name: "Ship release", start: null, due: at("17:00"), dueComplete: true, idMembers: ["me"], checklists: [
        { checkItems: [
          { id: "i1", name: "Write changelog", state: "complete", due: at("09:00"), idMember: null },
          { id: "i2", name: "Undated step", state: "incomplete", due: null },
          { id: "i3", name: "Someone else's step", state: "incomplete", due: at("09:00"), idMember: "bob" },
        ] },
      ] },
      { id: "c3", name: "Bob's card", due: at("12:00"), dueComplete: false, idMembers: ["bob"] },
      { id: "c4", name: "Backlog idea", start: null, due: null, dueComplete: false, idMembers: [] },
    ]);
    const items = await new TrelloProvider(opts(fetchImpl)).pull({ from: today, to: today });
    expect(items).toEqual([
      { externalId: "card:c1", title: "Design review", date: today, startTime: "10:00", durationMinutes: 90, done: false },
      { externalId: "card:c2", title: "Ship release", date: today, startTime: null, durationMinutes: null, done: true },
      { externalId: "item:c2:i1", title: "Write changelog", date: today, startTime: null, durationMinutes: null, done: true },
    ]);
  });

  it("ticks cards and checklist items in Trello", async () => {
    const { calls, fetchImpl } = fakeTrello([]);
    const p = new TrelloProvider(opts(fetchImpl));
    await p.setDone("card:c1", true);
    await p.setDone("item:c2:i1", false);
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["PUT", "/cards/c1"],
      ["PUT", "/cards/c2/checkItem/i1"],
    ]);
    expect(calls[0]!.params.get("dueComplete")).toBe("true");
    expect(calls[1]!.params.get("state")).toBe("incomplete");
  });

  it("creates cards for new tasks in the configured list and syncs them end to end", async () => {
    const { calls, fetchImpl } = fakeTrello([]);
    const store = new Store(":memory:");
    store.createTask({ title: "Call plumber", horizon: "day", periodStart: today, startTime: "09:00", durationMinutes: 15, source: "capture" });
    const trello = new TrelloProvider(opts(fetchImpl, { pushListId: "inbox" }));
    const report = await new SyncEngine(store, [trello], TZ).sync();
    expect(report.providers[0]!.created).toBe(1);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.params.get("idList")).toBe("inbox");
    expect(post.params.get("start")).toBe(at("09:00"));
    expect(post.params.get("due")).toBe(at("09:15"));
  });

  it("does not push when no list is configured", () => {
    const p = new TrelloProvider(opts(fakeTrello([]).fetchImpl));
    expect(p.shouldPush({ horizon: "day", startTime: null } as never)).toBe(false);
  });
});
