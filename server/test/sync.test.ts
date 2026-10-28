import { describe, expect, it } from "vitest";
import { todayIn } from "../src/dates.ts";
import { Store, type Task } from "../src/db.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { ExternalItemGone, type ExternalItem, type SyncProvider } from "../src/sync/provider.ts";

const TZ = "UTC";
const today = todayIn(TZ);

class FakeProvider implements SyncProvider {
  items = new Map<string, ExternalItem>();
  failPull = false;
  private next = 1;
  constructor(readonly name: string, private push: (t: Task) => boolean = () => false) {}
  isConfigured() { return true; }
  async pull() {
    if (this.failPull) throw new Error("offline");
    return [...this.items.values()].map((i) => ({ ...i }));
  }
  async setDone(id: string, done: boolean) {
    const item = this.items.get(id);
    if (!item) throw new ExternalItemGone(id);
    item.done = done;
  }
  shouldPush(t: Task) { return this.push(t); }
  async create(t: Task) {
    const id = `${this.name}-${this.next++}`;
    this.items.set(id, { externalId: id, title: t.title, date: t.periodStart!, startTime: t.startTime, durationMinutes: t.durationMinutes, done: t.done });
    return id;
  }
  add(title: string, done = false) {
    const id = `${this.name}-${this.next++}`;
    this.items.set(id, { externalId: id, title, date: today, startTime: null, durationMinutes: null, done });
    return id;
  }
}

describe("SyncEngine", () => {
  it("imports remote items as tasks for their day", async () => {
    const store = new Store(":memory:");
    const planner = new FakeProvider("planner");
    planner.add("Standup");
    const report = await new SyncEngine(store, [planner], TZ).sync();
    expect(report.providers[0]!.imported).toBe(1);
    expect(store.tasksInPeriod("day", today)[0]).toMatchObject({ title: "Standup", source: "planner", done: false });
  });

  it("propagates a completion from one app to the local list and every other app", async () => {
    const store = new Store(":memory:");
    const planner = new FakeProvider("planner");
    const calendar = new FakeProvider("calendar", () => true);
    const engine = new SyncEngine(store, [planner, calendar], TZ);
    const pid = planner.add("Write proposal");
    const cid = calendar.add("Write proposal");
    await engine.sync(); // both link to one local task
    expect(store.tasksInPeriod("day", today)).toHaveLength(1);

    planner.items.get(pid)!.done = true;
    await engine.sync();
    expect(store.tasksInPeriod("day", today)[0]!.done).toBe(true);
    expect(calendar.items.get(cid)!.done).toBe(true);
  });

  it("pushes tasks created here, but does not copy one app's items into another", async () => {
    const store = new Store(":memory:");
    const planner = new FakeProvider("planner", () => true);
    const calendar = new FakeProvider("calendar", () => true);
    calendar.add("Team meeting");
    const mine = store.createTask({ title: "Call plumber", horizon: "day", periodStart: today, source: "capture" });
    await new SyncEngine(store, [planner, calendar], TZ).sync();
    const plannerTitles = [...planner.items.values()].map((i) => i.title);
    expect(plannerTitles).toEqual(["Call plumber"]);
    expect(store.linksForTask(mine.id).map((l) => l.provider).sort()).toEqual(["calendar", "planner"]);
  });

  it("pushes a box ticked locally and leaves agreed state alone", async () => {
    const store = new Store(":memory:");
    const planner = new FakeProvider("planner");
    const engine = new SyncEngine(store, [planner], TZ);
    const pid = planner.add("Pay rent");
    await engine.sync();
    const task = store.tasksInPeriod("day", today)[0]!;
    store.updateTask(task.id, { done: true });
    const r = await engine.sync();
    expect(planner.items.get(pid)!.done).toBe(true);
    expect(r.providers[0]!.pushedCompletion).toBe(1);
    const again = await engine.sync();
    expect(again.providers[0]).toMatchObject({ pushedCompletion: 0, completedLocally: 0 });
  });

  it("lets a remote change win over an unchanged local state, including unticking", async () => {
    const store = new Store(":memory:");
    const planner = new FakeProvider("planner");
    const engine = new SyncEngine(store, [planner], TZ);
    const pid = planner.add("Laundry", true);
    await engine.sync();
    expect(store.tasksInPeriod("day", today)[0]!.done).toBe(true);
    planner.items.get(pid)!.done = false;
    await engine.sync();
    expect(store.tasksInPeriod("day", today)[0]!.done).toBe(false);
  });

  it("links the same item arriving from two apps instead of duplicating it", async () => {
    const store = new Store(":memory:");
    const a = new FakeProvider("a");
    const b = new FakeProvider("b");
    a.add("Dentist 3pm");
    b.add("dentist  3PM");
    await new SyncEngine(store, [a, b], TZ).sync();
    const tasks = store.tasksInPeriod("day", today);
    expect(tasks).toHaveLength(1);
    expect(store.linksForTask(tasks[0]!.id).map((l) => l.provider).sort()).toEqual(["a", "b"]);
  });

  it("does not push to a provider whose pull failed, and drops links to deleted items", async () => {
    const store = new Store(":memory:");
    const planner = new FakeProvider("planner");
    const engine = new SyncEngine(store, [planner], TZ);
    const pid = planner.add("Old item");
    await engine.sync();
    const task = store.tasksInPeriod("day", today)[0]!;
    store.updateTask(task.id, { done: true });

    planner.failPull = true;
    const r = await engine.sync();
    expect(r.providers[0]!.errors[0]).toContain("offline");
    expect(planner.items.get(pid)!.done).toBe(false);

    planner.failPull = false;
    planner.items.delete(pid);
    await engine.sync();
    expect(store.linksForTask(task.id)).toHaveLength(0);
  });
});
