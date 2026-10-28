import type { Task } from "../db.ts";

/** A checklist item as another app sees it, normalized to the user's timezone. */
export interface ExternalItem {
  externalId: string;
  title: string;
  /** YYYY-MM-DD the item belongs to. */
  date: string;
  startTime: string | null;
  durationMinutes: number | null;
  done: boolean;
}

/** Thrown by a provider when an item it was asked about no longer exists remotely. */
export class ExternalItemGone extends Error {}

/**
 * One external source of tasks (Google Calendar, a planner app, ...). To add a new
 * app, implement this interface and register it in index.ts; the sync engine does
 * the rest: importing items, two-way completion, and pushing local tasks.
 */
export interface SyncProvider {
  /** Stable identifier stored in links; never change it once data has synced. */
  readonly name: string;
  isConfigured(): boolean;
  /** Items dated within [from, to], inclusive. */
  pull(window: { from: string; to: string }): Promise<ExternalItem[]>;
  setDone(externalId: string, done: boolean): Promise<void>;
  /** Whether a local task without a link to this provider should be created there. */
  shouldPush(task: Task): boolean;
  /** Creates the task remotely and returns its external id. */
  create(task: Task): Promise<string>;
}
