import { describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { applyPlan, processCapture, renderUserMessage, type Operation, type Plan, type PlannerLLM } from "../src/planner.ts";

const TODAY = "2026-10-28";

function op(o: Partial<Operation>): Operation {
  return { action: "create", taskId: "", title: "", notes: "", horizon: "day", date: "", startTime: "", durationMinutes: 0, reason: "", ...o };
}

describe("applyPlan", () => {
  it("creates tasks on the right horizon and period", () => {
    const store = new Store(":memory:");
    const applied = applyPlan(store, {
      summary: "",
      operations: [
        op({ title: "Call mom", date: "2026-10-29", startTime: "17:00", durationMinutes: 15 }),
        op({ title: "Plan offsite", horizon: "week", date: "2026-11-05" }),
        op({ title: "Renew passport", horizon: "month", date: "2027-03-15" }),
        op({ title: "Run a marathon", horizon: "year", date: "2027-06-01" }),
        op({ title: "Learn piano", horizon: "someday" }),
      ],
    }, TODAY);

    expect(applied.map((a) => a.periodStart)).toEqual(["2026-10-29", "2026-11-02", "2027-03-01", "2027-01-01", null]);
    const call = store.tasksInPeriod("day", "2026-10-29")[0]!;
    expect(call).toMatchObject({ title: "Call mom", startTime: "17:00", durationMinutes: 15, source: "capture" });
  });

  it("defaults a missing or invalid date to today and ignores bad times", () => {
    const store = new Store(":memory:");
    applyPlan(store, { summary: "", operations: [op({ title: "Water plants", date: "soon", startTime: "5pm" })] }, TODAY);
    expect(store.tasksInPeriod("day", TODAY)[0]).toMatchObject({ title: "Water plants", startTime: null });
  });

  it("completes, reschedules and skips unknown ids", () => {
    const store = new Store(":memory:");
    const a = store.createTask({ title: "Write report", horizon: "day", periodStart: TODAY });
    const b = store.createTask({ title: "Gym", horizon: "day", periodStart: TODAY });
    const applied = applyPlan(store, {
      summary: "",
      operations: [
        op({ action: "complete", taskId: a.id }),
        op({ action: "reschedule", taskId: b.id, horizon: "week", date: "2026-11-04" }),
        op({ action: "complete", taskId: "made-up" }),
      ],
    }, TODAY);
    expect(store.getTask(a.id)!.done).toBe(true);
    expect(store.getTask(b.id)).toMatchObject({ horizon: "week", periodStart: "2026-11-02" });
    expect(applied[2]!.skipped).toBe("no matching task");
  });

  it("does not duplicate an open task in the same period", () => {
    const store = new Store(":memory:");
    store.createTask({ title: "Buy milk", horizon: "day", periodStart: TODAY });
    const applied = applyPlan(store, { summary: "", operations: [op({ title: "buy milk", date: TODAY })] }, TODAY);
    expect(applied[0]!.skipped).toBe("already on the list");
    expect(store.tasksInPeriod("day", TODAY)).toHaveLength(1);
  });
});

describe("processCapture", () => {
  it("passes open tasks to the planner and records the result", async () => {
    const store = new Store(":memory:");
    const existing = store.createTask({ title: "Email Sam", horizon: "day", periodStart: TODAY });
    let seen: string | undefined;
    const planner: PlannerLLM = {
      async plan(input) {
        seen = renderUserMessage(input);
        return { summary: "Done and added.", operations: [op({ action: "complete", taskId: existing.id }), op({ title: "Book flights", horizon: "week", date: "2026-11-03" })] } satisfies Plan;
      },
    };
    const out = await processCapture(store, planner, "emailed Sam; need to book flights next week", TODAY);
    expect(seen).toContain(`id=${existing.id}`);
    expect(seen).toContain("Wednesday, 2026-10-28");
    expect(out.applied).toHaveLength(2);
    expect(store.getTask(existing.id)!.done).toBe(true);
    expect(store.recentCaptures()[0]!.processedAt).not.toBeNull();
  });

  it("keeps the thought and records the error when the planner fails", async () => {
    const store = new Store(":memory:");
    const planner: PlannerLLM = { plan: async () => { throw new Error("boom"); } };
    await expect(processCapture(store, planner, "hello", TODAY)).rejects.toThrow("boom");
    expect(store.recentCaptures()[0]).toMatchObject({ text: "hello", processedAt: null, error: "boom" });
  });
});
