import { OAuth2Client, type Credentials } from "google-auth-library";
import { addDays } from "../dates.ts";
import type { Store, Task } from "../db.ts";
import { ExternalItemGone, type ExternalItem, type SyncProvider } from "./provider.ts";

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];
const TOKENS_KEY = "google.tokens";
const DONE_MARK = "✓ ";
const API = "https://www.googleapis.com/calendar/v3";

export type PushMode = "none" | "timed" | "all";

export interface GoogleCalendarOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  calendarId: string;
  timeZone: string;
  pushMode: PushMode;
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
}

/**
 * Syncs with one Google Calendar. Events in the window show up as checklist items
 * for their day. Checking an item off marks the event with a "✓ " title prefix and
 * a private property, so it is visible in Google Calendar too; adding or removing
 * the prefix in Calendar ticks or unticks the item here.
 */
export class GoogleCalendarProvider implements SyncProvider {
  readonly name = "google-calendar";
  private oauth: OAuth2Client;

  constructor(
    private store: Store,
    private opts: GoogleCalendarOptions,
  ) {
    this.oauth = new OAuth2Client({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      redirectUri: opts.redirectUri,
    });
    const saved = store.getSetting(TOKENS_KEY);
    if (saved) this.oauth.setCredentials(JSON.parse(saved) as Credentials);
    // Google only sends a refresh token on first consent; keep it when access tokens rotate.
    this.oauth.on("tokens", (tokens) => {
      const prev = JSON.parse(this.store.getSetting(TOKENS_KEY) ?? "{}") as Credentials;
      this.store.setSetting(TOKENS_KEY, JSON.stringify({ ...prev, ...tokens }));
    });
  }

  hasClientCredentials(): boolean {
    return Boolean(this.opts.clientId && this.opts.clientSecret);
  }

  isConfigured(): boolean {
    return this.hasClientCredentials() && Boolean(this.store.getSetting(TOKENS_KEY));
  }

  authUrl(state: string): string {
    return this.oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, state });
  }

  async handleCallback(code: string): Promise<void> {
    const { tokens } = await this.oauth.getToken(code);
    this.oauth.setCredentials(tokens);
    this.store.setSetting(TOKENS_KEY, JSON.stringify(tokens));
  }

  disconnect(): void {
    this.store.deleteSetting(TOKENS_KEY);
    this.oauth.setCredentials({});
  }

  async pull(window: { from: string; to: string }): Promise<ExternalItem[]> {
    const items: ExternalItem[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.oauth.request<{ items?: GoogleEvent[]; nextPageToken?: string }>({
        url: `${API}/calendars/${encodeURIComponent(this.opts.calendarId)}/events`,
        params: {
          // Pad by a day on each side; exact filtering happens on the local date below.
          timeMin: new Date(`${addDays(window.from, -1)}T00:00:00Z`).toISOString(),
          timeMax: new Date(`${addDays(window.to, 2)}T00:00:00Z`).toISOString(),
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 250,
          pageToken,
        },
      });
      for (const ev of res.data.items ?? []) {
        if (ev.status === "cancelled") continue;
        const item = this.toItem(ev);
        if (item && item.date >= window.from && item.date <= window.to) items.push(item);
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return items;
  }

  async setDone(externalId: string, done: boolean): Promise<void> {
    const url = this.eventUrl(externalId);
    let ev: GoogleEvent;
    try {
      ev = (await this.oauth.request<GoogleEvent>({ url })).data;
    } catch (e) {
      if (isNotFound(e)) throw new ExternalItemGone(externalId);
      throw e;
    }
    const title = stripMark(ev.summary ?? "");
    await this.oauth.request({
      url,
      method: "PATCH",
      data: {
        summary: done ? `${DONE_MARK}${title}` : title,
        extendedProperties: { private: { dailyGoalsDone: done ? "1" : "0" } },
      },
    });
  }

  shouldPush(task: Task): boolean {
    if (task.horizon !== "day") return false;
    if (this.opts.pushMode === "all") return true;
    return this.opts.pushMode === "timed" && task.startTime !== null;
  }

  async create(task: Task): Promise<string> {
    const date = task.periodStart!;
    const timing = task.startTime
      ? {
          start: { dateTime: `${date}T${task.startTime}:00`, timeZone: this.opts.timeZone },
          end: {
            dateTime: localPlusMinutes(date, task.startTime, task.durationMinutes ?? 30),
            timeZone: this.opts.timeZone,
          },
        }
      : { start: { date }, end: { date: addDays(date, 1) } };
    const res = await this.oauth.request<GoogleEvent>({
      url: `${API}/calendars/${encodeURIComponent(this.opts.calendarId)}/events`,
      method: "POST",
      data: {
        summary: task.title,
        description: task.notes || undefined,
        ...timing,
        extendedProperties: { private: { dailyGoalsTaskId: task.id, dailyGoalsDone: "0" } },
      },
    });
    return res.data.id;
  }

  private eventUrl(id: string): string {
    return `${API}/calendars/${encodeURIComponent(this.opts.calendarId)}/events/${encodeURIComponent(id)}`;
  }

  private toItem(ev: GoogleEvent): ExternalItem | null {
    const summary = ev.summary ?? "(no title)";
    const done = ev.extendedProperties?.private?.dailyGoalsDone === "1" || summary.startsWith(DONE_MARK.trim());
    if (ev.start?.date) {
      return { externalId: ev.id, title: stripMark(summary), date: ev.start.date, startTime: null, durationMinutes: null, done };
    }
    if (!ev.start?.dateTime) return null;
    const start = new Date(ev.start.dateTime);
    const { date, time } = localParts(start, this.opts.timeZone);
    const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;
    const durationMinutes = end ? Math.round((end.getTime() - start.getTime()) / 60_000) : null;
    return { externalId: ev.id, title: stripMark(summary), date, startTime: time, durationMinutes, done };
  }
}

function stripMark(s: string): string {
  return s.replace(/^\s*✓\s*/, "");
}

function localParts(d: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
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
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Wall-clock arithmetic: "2026-10-28" "23:45" + 30 -> "2026-10-29T00:15:00". */
export function localPlusMinutes(date: string, time: string, minutes: number): string {
  const d = new Date(`${date}T${time}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 19);
}

function isNotFound(e: unknown): boolean {
  const status = (e as { status?: number; response?: { status?: number } }).status ??
    (e as { response?: { status?: number } }).response?.status;
  return status === 404 || status === 410;
}
