import type { Task } from "../db.ts";
import { ExternalItemGone, type ExternalItem, type SyncProvider } from "./provider.ts";

const API = "https://api.trello.com/1";

export type TrelloPushMode = "none" | "timed" | "all";

export interface TrelloOptions {
  apiKey: string;
  token: string;
  /** Boards to read; empty means every open board you're a member of. */
  boardIds: string[];
  /** List new tasks from this app are created in; empty disables pushing. */
  pushListId: string;
  pushMode: TrelloPushMode;
  /** Skip cards and checklist items assigned only to other people. */
  onlyMine: boolean;
  timeZone: string;
  fetch?: typeof fetch;
}

interface TrelloCheckItem {
  id: string;
  name: string;
  state: "complete" | "incomplete";
  due?: string | null;
  idMember?: string | null;
}

interface TrelloCard {
  id: string;
  name: string;
  start?: string | null;
  due?: string | null;
  dueComplete: boolean;
  idMembers?: string[];
  checklists?: { checkItems: TrelloCheckItem[] }[];
}

/**
 * Planyway is a Trello Power-Up: what you schedule in it is stored on Trello
 * cards (start/due dates) and checklist items (due dates). This provider reads
 * and writes those through the Trello REST API, so changes show up in Planyway.
 *
 * - A dated card becomes a task on its start day (or due day); ticking it marks the
 *   card's due date complete.
 * - A dated checklist item becomes its own task; ticking it checks the item.
 */
export class TrelloProvider implements SyncProvider {
  readonly name = "trello";
  private memberId: string | null = null;
  private fetch: typeof fetch;

  constructor(private opts: TrelloOptions) {
    this.fetch = opts.fetch ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.opts.apiKey && this.opts.token);
  }

  async pull(window: { from: string; to: string }): Promise<ExternalItem[]> {
    this.memberId ??= (await this.call<{ id: string }>("GET", "/members/me", { fields: "id" })).id;
    const boardIds = this.opts.boardIds.length
      ? this.opts.boardIds
      : (await this.call<{ id: string }[]>("GET", "/members/me/boards", { filter: "open", fields: "id" })).map((b) => b.id);

    const items: ExternalItem[] = [];
    for (const boardId of boardIds) {
      const cards = await this.call<TrelloCard[]>("GET", `/boards/${boardId}/cards`, {
        filter: "open",
        fields: "name,start,due,dueComplete,idMembers",
        checklists: "all",
        checklist_fields: "none",
      });
      for (const card of cards) items.push(...this.toItems(card));
    }
    return items.filter((i) => i.date >= window.from && i.date <= window.to);
  }

  async setDone(externalId: string, done: boolean): Promise<void> {
    const [kind, cardId, itemId] = externalId.split(":");
    if (kind === "card") {
      await this.call("PUT", `/cards/${cardId}`, { dueComplete: String(done) });
    } else {
      await this.call("PUT", `/cards/${cardId}/checkItem/${itemId}`, { state: done ? "complete" : "incomplete" });
    }
  }

  shouldPush(task: Task): boolean {
    if (!this.opts.pushListId || task.horizon !== "day") return false;
    if (this.opts.pushMode === "all") return true;
    return this.opts.pushMode === "timed" && task.startTime !== null;
  }

  async create(task: Task): Promise<string> {
    const date = task.periodStart!;
    const params: Record<string, string> = { idList: this.opts.pushListId, name: task.title, pos: "bottom" };
    if (task.notes) params.desc = task.notes;
    if (task.startTime) {
      const start = zonedToUtc(date, task.startTime, this.opts.timeZone);
      params.start = start.toISOString();
      params.due = new Date(start.getTime() + (task.durationMinutes ?? 30) * 60_000).toISOString();
    } else {
      // No time: a due date at local noon keeps the card on the right day in any view.
      params.due = zonedToUtc(date, "12:00", this.opts.timeZone).toISOString();
    }
    const card = await this.call<{ id: string }>("POST", "/cards", params);
    return `card:${card.id}`;
  }

  toItems(card: TrelloCard): ExternalItem[] {
    const out: ExternalItem[] = [];
    if (this.isMine(card.idMembers ?? []) && (card.start || card.due)) {
      const start = card.start ? new Date(card.start) : null;
      const due = card.due ? new Date(card.due) : null;
      const anchor = localParts(start ?? due!, this.opts.timeZone);
      // Show a time only for a block scheduled within one day (e.g. 10:00-11:00 in Planyway).
      const sameDayBlock = start && due && localParts(due, this.opts.timeZone).date === anchor.date && due > start;
      out.push({
        externalId: `card:${card.id}`,
        title: card.name,
        date: anchor.date,
        startTime: sameDayBlock ? anchor.time : null,
        durationMinutes: sameDayBlock ? Math.round((due!.getTime() - start!.getTime()) / 60_000) : null,
        done: card.dueComplete,
      });
    }
    for (const checklist of card.checklists ?? []) {
      for (const item of checklist.checkItems) {
        if (!item.due || !this.isMine(item.idMember ? [item.idMember] : [])) continue;
        out.push({
          externalId: `item:${card.id}:${item.id}`,
          title: item.name,
          date: localParts(new Date(item.due), this.opts.timeZone).date,
          startTime: null,
          durationMinutes: null,
          done: item.state === "complete",
        });
      }
    }
    return out;
  }

  private isMine(memberIds: string[]): boolean {
    return !this.opts.onlyMine || memberIds.length === 0 || (this.memberId !== null && memberIds.includes(this.memberId));
  }

  private async call<T = unknown>(method: string, path: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams({ ...params, key: this.opts.apiKey, token: this.opts.token });
    const res = await this.fetch(`${API}${path}?${qs}`, { method, headers: { accept: "application/json" } });
    if (res.status === 404) throw new ExternalItemGone(path);
    if (!res.ok) throw new Error(`Trello ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}

function localParts(d: Date, timeZone: string): { date: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** The UTC instant of a wall-clock time in `timeZone` (DST-aware). */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  // Find the zone's offset at that moment and correct for it; a second pass handles DST edges.
  let result = guess;
  for (let i = 0; i < 2; i++) {
    const local = localParts(result, timeZone);
    const asUtc = new Date(`${local.date}T${local.time}:00Z`);
    result = new Date(result.getTime() + (guess.getTime() - asUtc.getTime()));
  }
  return result;
}
