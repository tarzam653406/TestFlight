import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Horizon } from "./dates.ts";

export interface Task {
  id: string;
  title: string;
  notes: string;
  horizon: Horizon;
  /** First day of the task's period (see dates.periodStart); null for "someday". */
  periodStart: string | null;
  /** Optional "HH:MM" start time for day tasks; makes them eligible for calendar push. */
  startTime: string | null;
  durationMinutes: number | null;
  done: boolean;
  completedAt: string | null;
  /** Where the task was first created: "app", "capture", or a provider name. */
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface Link {
  taskId: string;
  provider: string;
  externalId: string;
  /** Completion state both sides agreed on at the last sync; the base of the 3-way merge. */
  lastSyncedDone: boolean;
}

export interface Capture {
  id: string;
  text: string;
  createdAt: string;
  processedAt: string | null;
  /** JSON summary of what the planner did with the thought. */
  result: string | null;
  error: string | null;
}

type Row = Record<string, unknown>;

function rowToTask(r: Row): Task {
  return {
    id: r.id as string,
    title: r.title as string,
    notes: r.notes as string,
    horizon: r.horizon as Horizon,
    periodStart: (r.period_start as string | null) ?? null,
    startTime: (r.start_time as string | null) ?? null,
    durationMinutes: (r.duration_minutes as number | null) ?? null,
    done: r.done === 1,
    completedAt: (r.completed_at as string | null) ?? null,
    source: r.source as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToCapture(r: Row): Capture {
  return {
    id: r.id as string,
    text: r.text as string,
    createdAt: r.created_at as string,
    processedAt: (r.processed_at as string | null) ?? null,
    result: (r.result as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}

export type NewTask = Pick<Task, "title" | "horizon" | "periodStart"> &
  Partial<Pick<Task, "notes" | "startTime" | "durationMinutes" | "source" | "done">>;

export type TaskPatch = Partial<
  Pick<Task, "title" | "notes" | "horizon" | "periodStart" | "startTime" | "durationMinutes" | "done">
>;

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        horizon TEXT NOT NULL,
        period_start TEXT,
        start_time TEXT,
        duration_minutes INTEGER,
        done INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_period ON tasks (horizon, period_start);
      CREATE TABLE IF NOT EXISTS links (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        last_synced_done INTEGER NOT NULL,
        PRIMARY KEY (provider, external_id),
        UNIQUE (task_id, provider)
      );
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        processed_at TEXT,
        result TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // ---- tasks ----

  createTask(input: NewTask): Task {
    const now = new Date().toISOString();
    const done = input.done ?? false;
    const task: Task = {
      id: randomUUID(),
      title: input.title.trim(),
      notes: input.notes ?? "",
      horizon: input.horizon,
      periodStart: input.periodStart,
      startTime: input.startTime ?? null,
      durationMinutes: input.durationMinutes ?? null,
      done,
      completedAt: done ? now : null,
      source: input.source ?? "app",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, notes, horizon, period_start, start_time, duration_minutes,
           done, completed_at, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.title,
        task.notes,
        task.horizon,
        task.periodStart,
        task.startTime,
        task.durationMinutes,
        task.done ? 1 : 0,
        task.completedAt,
        task.source,
        task.createdAt,
        task.updatedAt,
      );
    return task;
  }

  getTask(id: string): Task | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return r && rowToTask(r);
  }

  updateTask(id: string, patch: TaskPatch): Task | undefined {
    const current = this.getTask(id);
    if (!current) return undefined;
    const next: Task = { ...current, ...patch, updatedAt: new Date().toISOString() };
    if (patch.done !== undefined && patch.done !== current.done) {
      next.completedAt = patch.done ? next.updatedAt : null;
    }
    this.db
      .prepare(
        `UPDATE tasks SET title = ?, notes = ?, horizon = ?, period_start = ?, start_time = ?,
           duration_minutes = ?, done = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.title,
        next.notes,
        next.horizon,
        next.periodStart,
        next.startTime,
        next.durationMinutes,
        next.done ? 1 : 0,
        next.completedAt,
        next.updatedAt,
        id,
      );
    return next;
  }

  deleteTask(id: string): boolean {
    return this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
  }

  tasksInPeriod(horizon: Horizon, periodStart: string | null): Task[] {
    const rows =
      periodStart === null
        ? this.db.prepare("SELECT * FROM tasks WHERE horizon = ? AND period_start IS NULL ORDER BY created_at").all(horizon)
        : this.db
            .prepare(
              "SELECT * FROM tasks WHERE horizon = ? AND period_start = ? ORDER BY done, start_time IS NULL, start_time, created_at",
            )
            .all(horizon, periodStart);
    return (rows as Row[]).map(rowToTask);
  }

  /** Open tasks whose period ended before `today` (for each horizon). */
  overdue(periods: { day: string; week: string; month: string; year: string }): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE done = 0 AND (
           (horizon = 'day' AND period_start < ?) OR
           (horizon = 'week' AND period_start < ?) OR
           (horizon = 'month' AND period_start < ?) OR
           (horizon = 'year' AND period_start < ?))
         ORDER BY period_start, created_at`,
      )
      .all(periods.day, periods.week, periods.month, periods.year);
    return (rows as Row[]).map(rowToTask);
  }

  openTasks(limit = 300): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE done = 0 ORDER BY period_start IS NULL, period_start, created_at LIMIT ?")
      .all(limit);
    return (rows as Row[]).map(rowToTask);
  }

  /** Every task with a period start within [from, to], for calendar push. */
  tasksBetween(from: string, to: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE horizon = 'day' AND period_start BETWEEN ? AND ?")
      .all(from, to);
    return (rows as Row[]).map(rowToTask);
  }

  // ---- links ----

  getLinkByExternal(provider: string, externalId: string): Link | undefined {
    const r = this.db
      .prepare("SELECT * FROM links WHERE provider = ? AND external_id = ?")
      .get(provider, externalId) as Row | undefined;
    return r && this.rowToLink(r);
  }

  getLinkByTask(taskId: string, provider: string): Link | undefined {
    const r = this.db
      .prepare("SELECT * FROM links WHERE task_id = ? AND provider = ?")
      .get(taskId, provider) as Row | undefined;
    return r && this.rowToLink(r);
  }

  linksFor(provider: string): Link[] {
    return (this.db.prepare("SELECT * FROM links WHERE provider = ?").all(provider) as Row[]).map((r) =>
      this.rowToLink(r),
    );
  }

  linksForTask(taskId: string): Link[] {
    return (this.db.prepare("SELECT * FROM links WHERE task_id = ?").all(taskId) as Row[]).map((r) =>
      this.rowToLink(r),
    );
  }

  upsertLink(link: Link): void {
    this.db
      .prepare(
        `INSERT INTO links (task_id, provider, external_id, last_synced_done) VALUES (?, ?, ?, ?)
         ON CONFLICT (provider, external_id) DO UPDATE SET task_id = excluded.task_id,
           last_synced_done = excluded.last_synced_done`,
      )
      .run(link.taskId, link.provider, link.externalId, link.lastSyncedDone ? 1 : 0);
  }

  deleteLink(provider: string, externalId: string): void {
    this.db.prepare("DELETE FROM links WHERE provider = ? AND external_id = ?").run(provider, externalId);
  }

  private rowToLink(r: Row): Link {
    return {
      taskId: r.task_id as string,
      provider: r.provider as string,
      externalId: r.external_id as string,
      lastSyncedDone: r.last_synced_done === 1,
    };
  }

  // ---- captures ----

  createCapture(text: string): Capture {
    const capture: Capture = {
      id: randomUUID(),
      text,
      createdAt: new Date().toISOString(),
      processedAt: null,
      result: null,
      error: null,
    };
    this.db
      .prepare("INSERT INTO captures (id, text, created_at) VALUES (?, ?, ?)")
      .run(capture.id, capture.text, capture.createdAt);
    return capture;
  }

  finishCapture(id: string, outcome: { result: string } | { error: string }): Capture | undefined {
    const now = new Date().toISOString();
    if ("result" in outcome) {
      this.db
        .prepare("UPDATE captures SET processed_at = ?, result = ?, error = NULL WHERE id = ?")
        .run(now, outcome.result, id);
    } else {
      this.db.prepare("UPDATE captures SET error = ? WHERE id = ?").run(outcome.error, id);
    }
    const r = this.db.prepare("SELECT * FROM captures WHERE id = ?").get(id) as Row | undefined;
    return r && rowToCapture(r);
  }

  recentCaptures(limit = 20): Capture[] {
    return (this.db.prepare("SELECT * FROM captures ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(
      rowToCapture,
    );
  }

  unprocessedCaptures(): Capture[] {
    return (
      this.db.prepare("SELECT * FROM captures WHERE processed_at IS NULL ORDER BY created_at").all() as Row[]
    ).map(rowToCapture);
  }

  // ---- settings ----

  getSetting(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return r?.value as string | undefined;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
