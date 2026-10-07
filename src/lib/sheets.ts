import { getKV } from "./store/kv";
import { getSettings, keys } from "./db";
import { googleAccessToken, serviceAccountToken } from "./connections";
import { http, httpJson } from "./http";
import type { Job, Platform } from "./types";
import { PLATFORMS } from "./types";

/**
 * Google Sheet = permanent, human-readable log (Runs + Activity tabs).
 * If Google is down / not connected, rows are buffered in Redis and flushed on the next tick — nothing is lost.
 */
export const TABS = {
  Runs: [
    "Finished (local)", "Job ID", "Status", "Schedule", "Added by", "Trigger", "Topic", "Story", "Story source",
    "Video title", "Voice", "Avatar", "Edit", ...PLATFORMS.map((p) => `${p} link`), "Errors", "Minutes taken",
  ],
  Activity: ["Time (local)", "Who", "Role", "Action", "Details"],
  Performance: ["Measured (local)", "Job ID", "Title", "Hook style", "Views (all platforms)", "Likes", "Comments", "Views per platform"],
} as const;

export type Tab = keyof typeof TABS;

export interface SheetWriter {
  append(tab: Tab, rows: string[][]): Promise<void>;
}

class GoogleSheetWriter implements SheetWriter {
  private ensured = new Set<string>();
  constructor(private sheetId: string) {}

  private async token() {
    return (await serviceAccountToken("https://www.googleapis.com/auth/spreadsheets")) ?? (await googleAccessToken());
  }

  private async ensureTab(tab: Tab, token: string) {
    if (this.ensured.has(tab)) return;
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}`;
    const meta = await httpJson<{ sheets: { properties: { title: string } }[] }>(`${base}?fields=sheets.properties.title`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meta.sheets.some((s) => s.properties.title === tab)) {
      await http(`${base}:batchUpdate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }] }),
      });
    }
    const head = await httpJson<{ values?: string[][] }>(`${base}/values/${encodeURIComponent(`${tab}!A1:A1`)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!head.values?.length) {
      await http(`${base}/values/${encodeURIComponent(`${tab}!A1`)}?valueInputOption=RAW`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [TABS[tab] as unknown as string[]] }),
      });
    }
    this.ensured.add(tab);
  }

  async append(tab: Tab, rows: string[][]) {
    const token = await this.token();
    await this.ensureTab(tab, token);
    await http(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}/values/${encodeURIComponent(`${tab}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: rows }),
      },
    );
  }
}

let override: SheetWriter | null = null;
export function setSheetWriter(w: SheetWriter | null) {
  override = w;
}

async function writer(): Promise<SheetWriter | null> {
  if (override) return override;
  const id = (await getSettings()).sheetId || process.env.GOOGLE_SHEET_ID;
  return id ? new GoogleSheetWriter(id) : null;
}

type Buffered = { tab: Tab; row: string[] };

export async function logRow(tab: Tab, row: string[]) {
  const kv = getKV();
  await kv.rpush(keys.sheetBuffer, { tab, row } satisfies Buffered);
  await flushSheet().catch(() => undefined);
}

/** Push buffered rows; leaves them buffered on failure. Returns number flushed. */
export async function flushSheet(): Promise<number> {
  const kv = getKV();
  const w = await writer();
  if (!w) return 0;
  const items = await kv.lrange<Buffered>(keys.sheetBuffer, 0, 199);
  if (!items.length) return 0;
  for (const tab of Object.keys(TABS) as Tab[]) {
    const rows = items.filter((i) => i.tab === tab).map((i) => i.row);
    if (rows.length) await w.append(tab, rows);
  }
  await kv.ltrim(keys.sheetBuffer, items.length, -1);
  return items.length;
}

export function localTime(tz: string, d = new Date()) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(d);
}

export async function logActivity(who: { name: string; email: string; role: string }, action: string, details: string) {
  const s = await getSettings();
  await logRow("Activity", [localTime(s.timezone), `${who.name} <${who.email}>`, who.role, action, details]);
}

export function jobRow(j: Job, tz: string): string[] {
  const pub = j.data.publish ?? {};
  const link = (p: Platform) => {
    const r = pub[p];
    if (!r) return j.platforms.includes(p) ? "not attempted" : "-";
    if (r.state === "done") return r.url ?? r.postId ?? "posted";
    if (r.state === "skipped") return `skipped: ${r.error ?? ""}`;
    return `FAILED: ${(r.error ?? "").slice(0, 150)}`;
  };
  const errors = j.logs.filter((l) => l.level === "error").map((l) => `[${l.stage}] ${l.msg}`).slice(-5).join(" | ");
  const mins = ((new Date(j.finishedAt ?? j.updatedAt).getTime() - new Date(j.createdAt).getTime()) / 60000).toFixed(1);
  return [
    localTime(tz, new Date(j.finishedAt ?? j.updatedAt)), j.id, j.status.toUpperCase(), j.scheduleName, j.createdBy, j.trigger, j.topic,
    j.data.story?.title ?? "", j.data.story?.url ?? "", j.data.script?.title ?? "", j.data.voiceProvider ?? "", j.data.avatarProvider ?? "",
    j.data.editMode ?? "", ...PLATFORMS.map(link), errors.slice(0, 1000), mins,
  ];
}
