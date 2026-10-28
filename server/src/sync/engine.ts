import { addDays, todayIn } from "../dates.ts";
import type { Store, Task } from "../db.ts";
import { ExternalItemGone, type ExternalItem, type SyncProvider } from "./provider.ts";

export interface ProviderReport {
  provider: string;
  imported: number;
  completedLocally: number;
  reopenedLocally: number;
  pushedCompletion: number;
  created: number;
  errors: string[];
}

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  providers: ProviderReport[];
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Two-way sync between the local store and every configured provider.
 *
 * Completion uses a three-way merge per link: `lastSyncedDone` is the state both
 * sides agreed on last time. If the remote differs from it, the remote changed and
 * wins; otherwise, if the local task differs, the local change is pushed. All
 * providers are pulled before any are pushed, so a box ticked in one app reaches
 * every other app in a single run.
 */
export class SyncEngine {
  private running: Promise<SyncReport> | null = null;
  lastReport: SyncReport | null = null;

  constructor(
    private store: Store,
    private providers: SyncProvider[],
    private timeZone: string,
    private window = { pastDays: 7, futureDays: 30 },
  ) {}

  /** Runs a sync, or joins the one already in progress. */
  sync(): Promise<SyncReport> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  configuredProviders(): SyncProvider[] {
    return this.providers.filter((p) => p.isConfigured());
  }

  private async run(): Promise<SyncReport> {
    const startedAt = new Date().toISOString();
    const today = todayIn(this.timeZone);
    const window = { from: addDays(today, -this.window.pastDays), to: addDays(today, this.window.futureDays) };
    const active = this.configuredProviders();
    const reports = new Map<string, ProviderReport>(
      active.map((p) => [
        p.name,
        { provider: p.name, imported: 0, completedLocally: 0, reopenedLocally: 0, pushedCompletion: 0, created: 0, errors: [] },
      ]),
    );

    // Phase 1: bring remote changes in.
    const pulled = new Map<string, ExternalItem[]>();
    for (const provider of active) {
      const report = reports.get(provider.name)!;
      try {
        const items = await provider.pull(window);
        pulled.set(provider.name, items);
        for (const item of items) this.applyRemote(provider, item, report);
      } catch (e) {
        report.errors.push(`pull: ${message(e)}`);
      }
    }

    // Phase 2: push local changes out. Skip providers whose pull failed, since
    // their remote state is unknown and pushing could overwrite a newer change.
    for (const provider of active) {
      if (!pulled.has(provider.name)) continue;
      const report = reports.get(provider.name)!;
      await this.pushCompletions(provider, report);
      await this.pushNewTasks(provider, window, report);
    }

    const result: SyncReport = { startedAt, finishedAt: new Date().toISOString(), providers: [...reports.values()] };
    this.lastReport = result;
    return result;
  }

  private applyRemote(provider: SyncProvider, item: ExternalItem, report: ProviderReport): void {
    const link = this.store.getLinkByExternal(provider.name, item.externalId);
    if (link) {
      const task = this.store.getTask(link.taskId);
      if (!task) {
        this.store.deleteLink(provider.name, item.externalId);
        return;
      }
      if (item.done !== link.lastSyncedDone) {
        if (task.done !== item.done) {
          this.store.updateTask(task.id, { done: item.done });
          if (item.done) report.completedLocally++;
          else report.reopenedLocally++;
        }
        this.store.upsertLink({ ...link, lastSyncedDone: item.done });
      }
      return;
    }

    // Unlinked: reuse a matching local task (e.g. the same item arriving from two
    // apps) instead of creating a duplicate.
    const match = this.store
      .tasksInPeriod("day", item.date)
      .find((t) => normalize(t.title) === normalize(item.title) && !this.store.getLinkByTask(t.id, provider.name));
    const task: Task =
      match ??
      this.store.createTask({
        title: item.title,
        horizon: "day",
        periodStart: item.date,
        startTime: item.startTime,
        durationMinutes: item.durationMinutes,
        done: item.done,
        source: provider.name,
      });
    if (!match) report.imported++;
    if (match && item.done && !match.done) {
      this.store.updateTask(match.id, { done: true });
      report.completedLocally++;
    }
    // Record the remote state as the agreed base; if the local task is done but the
    // remote isn't, phase 2 will push the completion.
    this.store.upsertLink({ taskId: task.id, provider: provider.name, externalId: item.externalId, lastSyncedDone: item.done });
  }

  private async pushCompletions(provider: SyncProvider, report: ProviderReport): Promise<void> {
    for (const link of this.store.linksFor(provider.name)) {
      const task = this.store.getTask(link.taskId);
      if (!task || task.done === link.lastSyncedDone) continue;
      try {
        await provider.setDone(link.externalId, task.done);
        this.store.upsertLink({ ...link, lastSyncedDone: task.done });
        report.pushedCompletion++;
      } catch (e) {
        if (e instanceof ExternalItemGone) this.store.deleteLink(provider.name, link.externalId);
        else report.errors.push(`complete "${task.title}": ${message(e)}`);
      }
    }
  }

  private async pushNewTasks(
    provider: SyncProvider,
    window: { from: string; to: string },
    report: ProviderReport,
  ): Promise<void> {
    for (const task of this.store.tasksBetween(window.from, window.to)) {
      if (task.done || !provider.shouldPush(task) || this.store.getLinkByTask(task.id, provider.name)) continue;
      try {
        const externalId = await provider.create(task);
        this.store.upsertLink({ taskId: task.id, provider: provider.name, externalId, lastSyncedDone: false });
        report.created++;
      } catch (e) {
        report.errors.push(`create "${task.title}": ${message(e)}`);
      }
    }
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
