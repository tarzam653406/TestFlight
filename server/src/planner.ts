import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { HORIZONS, isIsoDate, periodStart, relativeAnchors, weekday, type Horizon } from "./dates.ts";
import type { Store, Task } from "./db.ts";

// ---- plan shape (what Claude returns) ----

const Operation = z.object({
  action: z.enum(["create", "complete", "reopen", "reschedule", "update"]),
  taskId: z.string(),
  title: z.string(),
  notes: z.string(),
  horizon: z.enum(HORIZONS as [Horizon, ...Horizon[]]),
  date: z.string(),
  startTime: z.string(),
  durationMinutes: z.number().int(),
  reason: z.string(),
});
export type Operation = z.infer<typeof Operation>;

export const Plan = z.object({
  summary: z.string(),
  operations: z.array(Operation),
});
export type Plan = z.infer<typeof Plan>;

// Hand-written JSON schema for structured outputs (strict: every field required,
// no extra properties). "Not applicable" is expressed as "" or 0.
const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "operations"],
  properties: {
    summary: { type: "string", description: "One or two sentences telling the user what changed." },
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "taskId", "title", "notes", "horizon", "date", "startTime", "durationMinutes", "reason"],
        properties: {
          action: { type: "string", enum: ["create", "complete", "reopen", "reschedule", "update"] },
          taskId: { type: "string", description: "Id of an existing task; empty string for create." },
          title: { type: "string" },
          notes: { type: "string" },
          horizon: { type: "string", enum: [...HORIZONS] },
          date: { type: "string", description: "YYYY-MM-DD inside the target period, or empty for someday." },
          startTime: { type: "string", description: "HH:MM 24h if a time was given, else empty." },
          durationMinutes: { type: "integer", description: "0 if unknown." },
          reason: { type: "string", description: "Short justification, shown to the user." },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are the planning engine of a personal goals and to-do app. The user captures
thoughts on the go (often dictated, so expect run-on sentences and transcription errors), and you turn
each thought into changes to their task list.

Every task lives on one horizon:
- day: something to do on a specific date
- week: something to get done during a given week (weeks start Monday)
- month: a goal for a given month
- year: a goal for a given year
- someday: worth keeping, but no time frame was suggested

How to decide:
- Choose the horizon and date the thought implies. "Tomorrow" is a day task; "sometime next week" is a
  week task dated inside next week; "by the end of March" is a month task in March; "this year I want
  to..." is a year task. Specific dates and weekdays become day tasks.
- When the thought names no time at all, use a day task for today if it is small and actionable, or
  someday if it is an aspiration.
- A thought can contain several items; produce one operation per item.
- If the user says they finished, did, or no longer need something that matches an open task, emit
  "complete" with that task's id. If they postpone or move something, emit "reschedule" with the new
  horizon and date. Use "update" to rename a task or add notes. Use "reopen" only when they say an item
  is not actually done.
- Never invent a task id; only use ids from the open task list. Do not create a task that duplicates an
  open task in the same period.
- Titles are short imperative phrases ("Book dentist appointment"). Put extra context in notes.
- Musings with nothing actionable produce no operations; say so in the summary.
- For every operation, fill all fields: use "" or 0 for fields that do not apply, and for complete or
  update operations copy the task's current horizon and date.`;

export interface PlannerInput {
  text: string;
  today: string;
  openTasks: Task[];
}

export interface PlannerLLM {
  plan(input: PlannerInput): Promise<Plan>;
}

export class ClaudePlanner implements PlannerLLM {
  private client: Anthropic;

  constructor(client = new Anthropic()) {
    this.client = client;
  }

  async plan(input: PlannerInput): Promise<Plan> {
    const response = await this.client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      // If a safety classifier declines, retry server-side on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: PLAN_JSON_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: renderUserMessage(input) }],
    });

    if (response.stop_reason === "refusal") {
      throw new Error("Claude declined to process this thought.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("Claude's plan was cut off before it finished.");
    }
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return Plan.parse(JSON.parse(text));
  }
}

export function renderUserMessage({ text, today, openTasks }: PlannerInput): string {
  const anchors = Object.entries(relativeAnchors(today))
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const tasks = openTasks.length
    ? openTasks
        .map((t) => {
          const when = t.periodStart ? `${t.horizon} ${t.periodStart}` : "someday";
          return `- id=${t.id} [${when}${t.startTime ? ` ${t.startTime}` : ""}] ${t.title}`;
        })
        .join("\n")
    : "(none)";
  return `Today is ${weekday(today)}, ${today}.
Period start dates:
${anchors}

Open tasks:
${tasks}

<thought>
${text}
</thought>`;
}

// ---- applying a plan ----

export interface AppliedOperation {
  action: Operation["action"];
  title: string;
  horizon: Horizon;
  periodStart: string | null;
  taskId: string | null;
  skipped: string | null;
  reason: string;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function applyPlan(store: Store, plan: Plan, today: string, source = "capture"): AppliedOperation[] {
  return store.transaction(() =>
    plan.operations.map((op): AppliedOperation => {
      const date = op.date && isIsoDate(op.date) ? op.date : today;
      const period = periodStart(op.horizon, date);
      const startTime = op.horizon === "day" && TIME_RE.test(op.startTime) ? op.startTime : null;
      const durationMinutes = startTime && op.durationMinutes > 0 ? op.durationMinutes : null;
      const out: AppliedOperation = {
        action: op.action,
        title: op.title,
        horizon: op.horizon,
        periodStart: period,
        taskId: null,
        skipped: null,
        reason: op.reason,
      };

      if (op.action === "create") {
        if (!op.title.trim()) return { ...out, skipped: "empty title" };
        const dup = store
          .tasksInPeriod(op.horizon, period)
          .find((t) => !t.done && t.title.toLowerCase() === op.title.trim().toLowerCase());
        if (dup) return { ...out, taskId: dup.id, skipped: "already on the list" };
        const task = store.createTask({
          title: op.title,
          notes: op.notes,
          horizon: op.horizon,
          periodStart: period,
          startTime,
          durationMinutes,
          source,
        });
        return { ...out, taskId: task.id };
      }

      const existing = store.getTask(op.taskId);
      if (!existing) return { ...out, skipped: "no matching task" };
      out.taskId = existing.id;
      out.title = existing.title;

      switch (op.action) {
        case "complete":
          store.updateTask(existing.id, { done: true });
          break;
        case "reopen":
          store.updateTask(existing.id, { done: false });
          break;
        case "reschedule":
          store.updateTask(existing.id, { horizon: op.horizon, periodStart: period, startTime, durationMinutes });
          break;
        case "update": {
          const title = op.title.trim() || existing.title;
          store.updateTask(existing.id, { title, notes: op.notes || existing.notes });
          out.title = title;
          out.horizon = existing.horizon;
          out.periodStart = existing.periodStart;
          break;
        }
      }
      return out;
    }),
  );
}

/** Stores a thought, asks the planner what to do with it, and applies the result. */
export async function processCapture(
  store: Store,
  planner: PlannerLLM,
  text: string,
  /** The user's local date when the thought was captured, so "tomorrow" stays correct for queued captures. */
  today: string,
): Promise<{ captureId: string; summary: string; applied: AppliedOperation[] }> {
  const capture = store.createCapture(text);
  try {
    const plan = await planner.plan({ text, today, openTasks: store.openTasks() });
    const applied = applyPlan(store, plan, today);
    store.finishCapture(capture.id, { result: JSON.stringify({ summary: plan.summary, applied }) });
    return { captureId: capture.id, summary: plan.summary, applied };
  } catch (e) {
    store.finishCapture(capture.id, { error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
