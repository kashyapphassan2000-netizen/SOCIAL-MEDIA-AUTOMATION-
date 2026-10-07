"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { upload } from "@vercel/blob/client";
import type { Assets, BrandSettings, Job, Platform, Schedule, Session } from "@/lib/types";
import { PLATFORMS, PLATFORM_LABEL, STAGES } from "@/lib/types";

type Tab = "overview" | "schedules" | "studio" | "connections" | "settings" | "team" | "health";

async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) location.href = "/login";
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data as T;
}

function useToast() {
  const [t, setT] = useState<{ msg: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setT(null), 6000);
    return () => clearTimeout(id);
  }, [t]);
  return { toast: t, ok: (msg: string) => setT({ msg, ok: true }), err: (e: unknown) => setT({ msg: e instanceof Error ? e.message : String(e), ok: false }) };
}
type Toast = ReturnType<typeof useToast>;

const ago = (iso?: string) => {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

export function Dashboard({ user }: { user: Session }) {
  const owner = user.role === "owner";
  const [tab, setTab] = useState<Tab>("overview");
  const t = useToast();
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const tb = q.get("tab") as Tab | null;
    if (tb) setTab(tb);
    if (q.get("ok")) t.ok(q.get("ok")!);
    if (q.get("err")) t.err(q.get("err")!);
    if (q.size) history.replaceState(null, "", "/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tabs: [Tab, string, boolean][] = [
    ["overview", "Overview", true], ["schedules", "Schedules", true], ["studio", "Studio", true], ["connections", "Connections", true],
    ["settings", "Brand & Settings", owner], ["team", "Team", owner], ["health", "Health check", owner],
  ];
  return (
    <>
      <header className="top">
        <div className="brand"><i /> Shorts Autopilot</div>
        <div className="row" style={{ flex: "0 0 auto", gap: 8 }}>
          <span className="muted small hide-sm">{user.name} · {user.role}</span>
          <button onClick={async () => { await api("/api/auth/logout", { method: "POST" }); location.href = "/login"; }}>Sign out</button>
        </div>
      </header>
      <div className="wrap">
        <nav className="tabs">
          {tabs.filter((x) => x[2]).map(([k, label]) => (
            <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
        {tab === "overview" && <Overview owner={owner} t={t} />}
        {tab === "schedules" && <Schedules user={user} t={t} />}
        {tab === "studio" && <Studio t={t} owner={owner} />}
        {tab === "connections" && <Connections owner={owner} t={t} />}
        {tab === "settings" && owner && <Settings t={t} />}
        {tab === "team" && owner && <Team t={t} />}
        {tab === "health" && owner && <Health />}
      </div>
      {t.toast && <div className={`toast ${t.toast.ok ? "ok" : "err"}`} onClick={() => t.ok("")}>{t.toast.msg}</div>}
    </>
  );
}

// ---------------------------------------------------------------- Overview
function Overview({ owner, t }: { owner: boolean; t: Toast }) {
  const [data, setData] = useState<{ jobs: Job[]; today: { videos: number; cap: number }; blocked?: { at: string; problems: string[] } | null } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api("/api/jobs").then(setData).catch(t.err), [t.err]);
  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);
  const active = data?.jobs.filter((j) => j.stage !== "done") ?? [];
  const finished = data?.jobs.filter((j) => j.stage === "done") ?? [];
  const posted = finished.reduce((a, j) => a + Object.values(j.data.publish ?? {}).filter((r) => r?.state === "done").length, 0);
  return (
    <>
      <div className="grid">
        <div className="card"><div className="muted small">Videos today</div><div className="stat">{data?.today.videos ?? "–"} <span className="muted small">/ {data?.today.cap ?? "–"} cap</span></div></div>
        <div className="card"><div className="muted small">In progress</div><div className="stat">{active.length}</div></div>
        <div className="card"><div className="muted small">Posts (last 7 days)</div><div className="stat">{posted}</div></div>
        <div className="card">
          <div className="muted small">Worker</div>
          <div className="row" style={{ marginTop: 6 }}>
            {owner && (
              <button className="primary" disabled={busy} onClick={async () => {
                setBusy(true);
                try {
                  const r = await api("/api/cron/tick", { method: "POST" });
                  t.ok(r.status === "busy" ? "Worker already running" : `Worker ran ${r.steps} steps, created ${r.created} job(s)`);
                  load();
                } catch (e) { t.err(e); } finally { setBusy(false); }
              }}>{busy ? "Running…" : "Run worker now"}</button>
            )}
          </div>
        </div>
      </div>
      {data?.blocked && (
        <div className="card" style={{ borderColor: "var(--bad)" }}>
          <b style={{ color: "var(--bad)" }}>Automation paused — setup incomplete</b>
          <ul className="small">{data.blocked.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          <span className="muted small">Checked {ago(data.blocked.at)}. Fix these and the next worker run resumes automatically.</span>
        </div>
      )}
      <h2 style={{ marginTop: 18 }}>Jobs</h2>
      {!data && <p className="muted">Loading…</p>}
      {data && !data.jobs.length && <div className="card muted">No jobs yet. Create a schedule, then press “Make one now”.</div>}
      {data?.jobs.map((j) => <JobCard key={j.id} j={j} open={open === j.id} toggle={() => setOpen(open === j.id ? null : j.id)} t={t} reload={load} />)}
    </>
  );
}

function JobCard({ j, open, toggle, t, reload }: { j: Job; open: boolean; toggle: () => void; t: Toast; reload: () => void }) {
  const idx = STAGES.indexOf(j.stage);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div style={{ flex: "1 1 260px" }}>
          <span className={`badge b-${j.status}`}>{j.status}</span> <b>{j.data.script?.title ?? j.data.story?.title ?? j.scheduleName}</b>
          <div className="muted small">{j.scheduleName} · {j.trigger} by {j.createdBy} · {ago(j.createdAt)} · stage: {j.stage}{j.nextAttemptAt && j.stage !== "done" ? (new Date(j.nextAttemptAt).getTime() > Date.now() ? ` (next check in ${Math.round((new Date(j.nextAttemptAt).getTime() - Date.now()) / 1000)}s)` : " (due now)") : ""}</div>
        </div>
        <div className="row" style={{ flex: "0 0 auto" }}>
          <button onClick={toggle}>{open ? "Hide" : "Details"}</button>
          {j.stage !== "done" && (
            <button className="danger" onClick={async () => { if (!confirm("Cancel this job?")) return; try { await api(`/api/jobs/${j.id}`, { method: "DELETE" }); reload(); } catch (e) { t.err(e); } }}>Cancel</button>
          )}
        </div>
      </div>
      <div className="stages">
        {STAGES.slice(0, -1).map((s, i) => (
          <span key={s} title={s} className={j.stage === "done" || i < idx ? (j.status === "failed" && i >= idx - 1 && j.stage !== "done" ? "fail" : "done") : i === idx ? (j.status === "failed" ? "fail" : "cur") : ""} />
        ))}
      </div>
      <div className="chips">
        {j.platforms.map((p) => {
          const r = j.data.publish?.[p];
          const label = `${PLATFORM_LABEL[p]}: ${r?.state ?? "–"}`;
          return r?.url ? <a key={p} className="chip on" href={r.url} target="_blank" rel="noreferrer">{label} ↗</a> : <span key={p} className="chip" title={r?.error}>{label}</span>;
        })}
      </div>
      {j.error && <p style={{ color: "var(--bad)" }} className="small">{j.error}</p>}
      {open && (
        <>
          {j.data.story && <p className="small"><b>Story:</b> {j.data.story.title} {j.data.story.url && <a href={j.data.story.url} target="_blank" rel="noreferrer">source</a>} {j.data.story.viralityScore ? `· virality ${j.data.story.viralityScore}` : ""}</p>}
          {j.data.script && <p className="small"><b>Script:</b> {j.data.script.spoken}</p>}
          <p className="small muted">Look: {j.data.lookName ?? "–"} · Voice: {j.data.voiceProvider ?? "–"} · Avatar: {j.data.avatarProvider ?? "–"} · Edit: {j.data.editMode ?? "–"}</p>
          {j.data.videoUrl && j.stage !== "done" && <video src={j.data.videoUrl} controls playsInline className="preview" style={{ width: 180 }} />}
          <div className="log">{j.logs.map((l, i) => <div key={i} className={l.level}>{new Date(l.t).toLocaleTimeString()} [{l.stage}] {l.msg}</div>)}</div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Schedules
const emptySchedule = (): Omit<Schedule, "id" | "createdBy" | "createdAt" | "updatedAt"> => ({
  name: "AI News", topic: "AI news", instructions: "", queries: [], language: "en", everyHours: 1, windowStartHour: 8, windowEndHour: 23,
  platforms: [...PLATFORMS], targetSeconds: 45, publishMode: "private", enabled: true,
});

function Schedules({ user, t }: { user: Session; t: Toast }) {
  const [list, setList] = useState<Schedule[] | null>(null);
  const [edit, setEdit] = useState<(ReturnType<typeof emptySchedule> & { id?: string }) | null>(null);
  const load = useCallback(() => api("/api/schedules").then((r) => setList(r.schedules)).catch(t.err), [t.err]);
  useEffect(() => { load(); }, [load]);
  async function save() {
    if (!edit) return;
    try {
      const { id, ...payload } = edit;
      await api(id ? `/api/schedules/${id}` : "/api/schedules", { method: id ? "PUT" : "POST", body: JSON.stringify(payload) });
      t.ok("Schedule saved");
      setEdit(null);
      load();
    } catch (e) { t.err(e); }
  }
  const canEdit = (s: Schedule) => user.role === "owner" || s.createdBy === user.email;
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <h2 style={{ margin: 0 }}>Schedules</h2>
        <button className="primary" style={{ flex: "0 0 auto" }} onClick={() => setEdit(emptySchedule())}>+ New schedule</button>
      </div>
      <p className="muted small">A schedule = “what to post and how often”. The worker checks every run; when a schedule is due it researches trends, makes a short and posts it. New schedules start in <b>private test mode</b> (YouTube private only) — switch to Live once you like the output.</p>
      {edit && (
        <div className="card">
          <h3>{edit.id ? "Edit schedule" : "New schedule"}</h3>
          <div className="row">
            <div><label>Name</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div><label>Topic / niche</label><input value={edit.topic} placeholder="AI news, personal finance, cricket…" onChange={(e) => setEdit({ ...edit, topic: e.target.value })} /></div>
          </div>
          <label>Direction for the writer (audience, tone, do / don’t)</label>
          <textarea value={edit.instructions} placeholder="Indian audience, practical career angle, no hype, mention what it means for jobs" onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} />
          <label>Extra search queries (comma separated, optional)</label>
          <input value={edit.queries.join(", ")} onChange={(e) => setEdit({ ...edit, queries: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
          <div className="row">
            <div><label>Every (hours)</label><input type="number" min={1} max={168} value={edit.everyHours} onChange={(e) => setEdit({ ...edit, everyHours: Number(e.target.value) })} /></div>
            <div><label>Window start (hour)</label><input type="number" min={0} max={23} value={edit.windowStartHour} onChange={(e) => setEdit({ ...edit, windowStartHour: Number(e.target.value) })} /></div>
            <div><label>Window end (hour)</label><input type="number" min={0} max={23} value={edit.windowEndHour} onChange={(e) => setEdit({ ...edit, windowEndHour: Number(e.target.value) })} /></div>
            <div><label>Length (sec)</label><input type="number" min={20} max={58} value={edit.targetSeconds} onChange={(e) => setEdit({ ...edit, targetSeconds: Number(e.target.value) })} /></div>
            <div><label>Language</label><input value={edit.language} onChange={(e) => setEdit({ ...edit, language: e.target.value })} /></div>
          </div>
          <p className="muted small">Window start = end means 24h. Times use the brand timezone.</p>
          <label>Platforms</label>
          <div className="chips">
            {PLATFORMS.map((p) => (
              <button key={p} type="button" className={`chip ${edit.platforms.includes(p) ? "on" : ""}`} onClick={() => setEdit({ ...edit, platforms: edit.platforms.includes(p) ? edit.platforms.filter((x) => x !== p) : [...edit.platforms, p] })}>{PLATFORM_LABEL[p]}</button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <div><label>Mode</label>
              <select value={edit.publishMode} onChange={(e) => setEdit({ ...edit, publishMode: e.target.value as "live" | "private" })}>
                <option value="private">Private test (YouTube private only)</option>
                <option value="live">LIVE — post publicly everywhere</option>
              </select>
            </div>
            <div><label>Enabled</label>
              <select value={edit.enabled ? "1" : "0"} onChange={(e) => setEdit({ ...edit, enabled: e.target.value === "1" })}><option value="1">On</option><option value="0">Paused</option></select>
            </div>
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="primary" onClick={save}>Save</button>
            <button onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
      {list?.map((s) => (
        <div key={s.id} className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div style={{ flex: "1 1 260px" }}>
              <b>{s.name}</b> <span className={`badge ${s.enabled ? "b-done" : "b-failed"}`}>{s.enabled ? "on" : "paused"}</span> <span className={`badge ${s.publishMode === "live" ? "b-running" : "b-waiting"}`}>{s.publishMode}</span>
              <div className="muted small">“{s.topic}” · every {s.everyHours}h {s.windowStartHour !== s.windowEndHour ? `between ${s.windowStartHour}:00–${s.windowEndHour}:00` : "all day"} · {s.platforms.map((p) => PLATFORM_LABEL[p]).join(", ")} · added by {s.createdBy} · last run {ago(s.lastRunAt) || "never"}</div>
            </div>
            <div className="row" style={{ flex: "0 0 auto" }}>
              <button className="primary" onClick={async () => { try { const r = await api("/api/jobs/run", { method: "POST", body: JSON.stringify({ scheduleId: s.id }) }); t.ok(r.note ?? "Job started — watch it on Overview"); } catch (e) { t.err(e); } }}>Make one now</button>
              {canEdit(s) && <button onClick={() => setEdit({ ...s })}>Edit</button>}
              {canEdit(s) && <button className="danger" onClick={async () => { if (!confirm(`Delete "${s.name}"?`)) return; try { await api(`/api/schedules/${s.id}`, { method: "DELETE" }); load(); } catch (e) { t.err(e); } }}>Delete</button>}
            </div>
          </div>
        </div>
      ))}
      {list && !list.length && !edit && <div className="card muted">No schedules yet.</div>}
    </>
  );
}

// ---------------------------------------------------------------- Studio
function Studio({ t, owner }: { t: Toast; owner: boolean }) {
  const [a, setA] = useState<{ assets: Assets; blobUploads: boolean } | null>(null);
  const [settings, setSettings] = useState<BrandSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    api("/api/studio/assets").then(setA).catch(t.err);
    api("/api/settings").then((r) => setSettings(r.settings)).catch(t.err);
  }, [t.err]);
  useEffect(() => { load(); }, [load]);
  async function send(kind: "photo" | "clip", file: File) {
    setBusy(kind);
    try {
      let r;
      if (a?.blobUploads) {
        const blob = await upload(`uploads/${kind}-${file.name}`, file, { access: "public", handleUploadUrl: "/api/studio/upload", multipart: file.size > 20e6 });
        r = await api("/api/studio/assets", { method: "POST", body: JSON.stringify({ kind, url: blob.url }) });
      } else {
        const fd = new FormData();
        fd.set("kind", kind);
        fd.set("file", file);
        r = await api("/api/studio/assets", { method: "POST", body: fd });
      }
      t.ok((r.notes ?? ["Saved"]).join(" "));
      load();
    } catch (e) { t.err(e); } finally { setBusy(null); }
  }
  return (
    <>
      <h2 style={{ marginTop: 8 }}>Studio — your face & voice</h2>
      <div className="grid">
        <div className="card">
          <h3>1. Photo</h3>
          <p className="muted small">Front-facing, eyes to camera, chest-up, good light, neutral background, mouth closed. 1080px+ tall. This is the face every video uses.</p>
          {a?.assets.photoUrl && <img src={a.assets.photoUrl.startsWith("file://") ? undefined : a.assets.photoUrl} alt="photo" className="preview" />}
          <label className="btn primary" style={{ marginTop: 10 }}>{busy === "photo" ? "Uploading…" : a?.assets.photoUrl ? "Replace photo" : "Upload photo"}
            <input type="file" accept="image/*" hidden disabled={!!busy} onChange={(e) => e.target.files?.[0] && send("photo", e.target.files[0])} />
          </label>
        </div>
        <div className="card">
          <h3>2. Voice clip</h3>
          <p className="muted small">60–120 seconds of you talking naturally (video or audio). Quiet room, no music, one speaker. Used to clone your voice — and as the body-motion source in “clip” avatar mode.</p>
          {a?.assets.voiceSampleUrl && <audio controls src={a.assets.voiceSampleUrl.startsWith("file://") ? undefined : a.assets.voiceSampleUrl} style={{ width: "100%" }} />}
          <p className="small">{a?.assets.elevenVoiceId ? "✅ ElevenLabs clone ready" : a?.assets.voiceSampleUrl ? "Voice sample ready (clone is created on first video if needed)" : "Not uploaded"}</p>
          <label className="btn primary">{busy === "clip" ? "Processing…" : a?.assets.voiceSampleUrl ? "Replace clip" : "Upload clip"}
            <input type="file" accept="video/*,audio/*" hidden disabled={!!busy} onChange={(e) => e.target.files?.[0] && send("clip", e.target.files[0])} />
          </label>
        </div>
      </div>
      {settings && (
        <div className="card">
          <h3>Brand looks (rotating outfits)</h3>
          <p className="muted small">Each video rotates to the next look. Looks are AI-edited from your photo once, then reused. {owner ? "Edit them in Brand & Settings." : ""}</p>
          <div className="row" style={{ alignItems: "flex-start" }}>
            {settings.looks.map((l) => (
              <div key={l.name} style={{ flex: "0 0 130px" }}>
                {l.imageUrl && !l.imageUrl.startsWith("file://") ? <img src={l.imageUrl} alt={l.name} className="preview" /> : <div className="preview" style={{ display: "grid", placeItems: "center" }}><span className="muted small">not yet generated</span></div>}
                <div className="small"><b>{l.name}</b></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Connections
const CONN: { key: string; oauth: string; label: string; manual?: "instagram" | "facebook" | "threads"; note: string }[] = [
  { key: "google", oauth: "google", label: "YouTube + Google Sheets", note: "One Google login uploads Shorts and writes the log sheet." },
  { key: "instagram", oauth: "instagram", label: "Instagram (Reels)", manual: "instagram", note: "Instagram Professional (Creator/Business) account required." },
  { key: "facebook", oauth: "facebook", label: "Facebook Page (Reels)", manual: "facebook", note: "Posts to a Facebook Page, not a personal profile (API limitation)." },
  { key: "threads", oauth: "threads", label: "Threads", manual: "threads", note: "" },
  { key: "x", oauth: "x", label: "X (Twitter)", note: "Your X developer plan must allow posting + media upload." },
  { key: "linkedin", oauth: "linkedin", label: "LinkedIn (personal)", note: "Tokens last 60 days — you get a warning before expiry." },
];

function Connections({ owner, t }: { owner: boolean; t: Toast }) {
  const [d, setD] = useState<{ connections: Record<string, any>; oauthMissing: Record<string, string[]>; redirectBase: string } | null>(null);
  const [manual, setManual] = useState<{ platform: string; token: string; accountId: string } | null>(null);
  const load = useCallback(() => api("/api/connections").then(setD).catch(t.err), [t.err]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <h2 style={{ marginTop: 8 }}>Connections</h2>
      {CONN.map((c) => {
        const conn = d?.connections[c.key];
        const missing = d?.oauthMissing[c.oauth] ?? [];
        const days = conn?.expiresAt ? Math.round((new Date(conn.expiresAt).getTime() - Date.now()) / 86400000) : null;
        return (
          <div className="card" key={c.key}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div style={{ flex: "1 1 260px" }}>
                <span className={conn?.status === "ok" ? "ok-dot" : "bad-dot"} /><b>{c.label}</b>{" "}
                <span className="muted small">{conn ? `${conn.accountName ?? conn.accountId ?? "connected"}${conn.status !== "ok" ? ` — ${conn.status}` : ""}${days !== null && days < 20 ? ` — token expires in ${days} days` : ""}` : "not connected"}</span>
                {conn?.lastError && <div className="small" style={{ color: "var(--warn)" }}>{conn.lastError}</div>}
                <div className="muted small">{c.note}</div>
                {owner && missing.length > 0 && <div className="small muted">OAuth button needs env: {missing.join(", ")} · redirect URI: <code>{d?.redirectBase}/{c.oauth}/callback</code></div>}
              </div>
              {owner && (
                <div className="row" style={{ flex: "0 0 auto" }}>
                  <a className={`btn ${missing.length ? "" : "primary"}`} href={missing.length ? undefined : `/api/oauth/${c.oauth}/start`} onClick={(e) => missing.length && (e.preventDefault(), t.err(`Set ${missing.join(", ")} first`))}>{conn ? "Reconnect" : "Connect"}</a>
                  {c.manual && <button onClick={() => setManual({ platform: c.manual!, token: "", accountId: "" })}>Paste token</button>}
                  {conn && <button className="danger" onClick={async () => { if (!confirm("Disconnect?")) return; await api(`/api/connections?platform=${c.key}`, { method: "DELETE" }).catch(t.err); load(); }}>Disconnect</button>}
                </div>
              )}
            </div>
            {manual && manual.platform === c.manual && (
              <div style={{ marginTop: 10 }}>
                <label>Long-lived access token</label>
                <input value={manual.token} onChange={(e) => setManual({ ...manual, token: e.target.value })} />
                <label>{c.key === "facebook" ? "Page ID (required)" : "Account ID (optional — detected from token)"}</label>
                <input value={manual.accountId} onChange={(e) => setManual({ ...manual, accountId: e.target.value })} />
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="primary" onClick={async () => { try { const r = await api("/api/connections", { method: "POST", body: JSON.stringify(manual) }); t.ok(r.message); setManual(null); load(); } catch (e) { t.err(e); } }}>Verify & save</button>
                  <button onClick={() => setManual(null)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div className="card muted small">TikTok is intentionally not included (banned in India). Snapchat Spotlight, Moj and Josh have no public posting API.</div>
    </>
  );
}

// ---------------------------------------------------------------- Settings
function Settings({ t }: { t: Toast }) {
  const [s, setS] = useState<BrandSettings | null>(null);
  const [opts, setOpts] = useState<{ avatar: string[]; voice: string[]; llm: string[] } | null>(null);
  useEffect(() => { api("/api/settings").then((r) => { setS(r.settings); setOpts(r.options); }).catch(t.err); }, [t.err]);
  if (!s || !opts) return <p className="muted">Loading…</p>;
  const set = (p: Partial<BrandSettings>) => setS({ ...s, ...p });
  const order = (k: "avatarProviders" | "voiceProviders" | "llmProviders", all: string[]) => (
    <div className="chips">
      {all.map((n) => {
        const i = s[k].indexOf(n);
        return <button key={n} type="button" className={`chip ${i >= 0 ? "on" : ""}`} onClick={() => set({ [k]: i >= 0 ? s[k].filter((x) => x !== n) : [...s[k], n] } as Partial<BrandSettings>)}>{i >= 0 ? `${i + 1}. ` : ""}{n}</button>;
      })}
    </div>
  );
  return (
    <>
      <h2 style={{ marginTop: 8 }}>Brand & Settings</h2>
      <div className="card">
        <h3>Brand</h3>
        <div className="row">
          <div><label>Brand name</label><input value={s.brandName} onChange={(e) => set({ brandName: e.target.value })} /></div>
          <div><label>Handle (watermark)</label><input value={s.handle} onChange={(e) => set({ handle: e.target.value })} /></div>
          <div><label>Timezone</label><input value={s.timezone} onChange={(e) => set({ timezone: e.target.value })} /></div>
        </div>
        <div className="row">
          <div><label>Primary colour</label><input type="color" className="swatch" value={s.primaryColor} onChange={(e) => set({ primaryColor: e.target.value })} /></div>
          <div><label>Accent colour (captions highlight)</label><input type="color" className="swatch" value={s.accentColor} onChange={(e) => set({ accentColor: e.target.value })} /></div>
          <div><label>Text colour</label><input type="color" className="swatch" value={s.textColor} onChange={(e) => set({ textColor: e.target.value })} /></div>
        </div>
        <label>Default end-card call to action</label>
        <input value={s.ctaText} onChange={(e) => set({ ctaText: e.target.value })} />
      </div>
      <div className="card">
        <h3>Looks (outfits / specs / style)</h3>
        <label><input type="checkbox" style={{ width: "auto" }} checked={s.generateLooks} onChange={(e) => set({ generateLooks: e.target.checked })} /> Generate rotating looks from my photo</label>
        {s.looks.map((l, i) => (
          <div className="row" key={i}>
            <div style={{ flex: "0 1 180px" }}><input value={l.name} onChange={(e) => set({ looks: s.looks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /></div>
            <div style={{ flex: "3 1 300px" }}><input value={l.prompt} onChange={(e) => set({ looks: s.looks.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)) })} /></div>
            <button className="danger" style={{ flex: "0 0 auto" }} onClick={() => set({ looks: s.looks.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <button style={{ marginTop: 8 }} onClick={() => set({ looks: [...s.looks, { name: `Look ${s.looks.length + 1}`, prompt: "wearing a navy polo shirt" }] })}>+ Add look</button>
      </div>
      <div className="card">
        <h3>Safety fuses (spend + spam protection)</h3>
        <div className="row">
          <div><label>Max videos per day (all schedules)</label><input type="number" min={0} value={s.maxVideosPerDay} onChange={(e) => set({ maxVideosPerDay: Number(e.target.value) })} /></div>
          {PLATFORMS.map((p) => (
            <div key={p}><label>{PLATFORM_LABEL[p]} / day</label><input type="number" min={0} value={s.dailyPlatformCaps[p]} onChange={(e) => set({ dailyPlatformCaps: { ...s.dailyPlatformCaps, [p]: Number(e.target.value) } })} /></div>
          ))}
        </div>
      </div>
      <div className="card">
        <h3>Production</h3>
        <div className="row">
          <div><label>Avatar mode</label><select value={s.avatarMode} onChange={(e) => set({ avatarMode: e.target.value as "photo" | "clip" })}><option value="photo">Photo → talking video (supports outfit looks)</option><option value="clip">Re-lip-sync my recorded clip (most realistic motion)</option></select></div>
          <div><label>YouTube privacy (live mode)</label><select value={s.youtubePrivacy} onChange={(e) => set({ youtubePrivacy: e.target.value as BrandSettings["youtubePrivacy"] })}><option>public</option><option>unlisted</option><option>private</option></select></div>
          <div><label>YouTube category id</label><input value={s.youtubeCategoryId} onChange={(e) => set({ youtubeCategoryId: e.target.value })} /></div>
        </div>
        <label><input type="checkbox" style={{ width: "auto" }} checked={s.allowStillImageFallback} onChange={(e) => set({ allowStillImageFallback: e.target.checked })} /> If every avatar service fails, publish an animated still photo (no lip-sync) instead of skipping</label>
        <label><input type="checkbox" style={{ width: "auto" }} checked={s.allowGenericVoiceFallback} onChange={(e) => set({ allowGenericVoiceFallback: e.target.checked })} /> If voice cloning fails, use a generic AI voice (NOT your voice — brand risk)</label>
        <label>Avatar providers (tap to toggle, order = priority)</label>{order("avatarProviders", opts.avatar.filter((x) => x !== "fal-lipsync-clip"))}
        <label>Voice providers</label>{order("voiceProviders", opts.voice.filter((x) => x !== "openai-tts"))}
        <label>Script AI providers</label>{order("llmProviders", opts.llm)}
        <div className="row">
          <div><label>Background music URL (royalty-free mp3, optional)</label><input value={s.musicUrl} onChange={(e) => set({ musicUrl: e.target.value })} /></div>
          <div style={{ flex: "0 1 140px" }}><label>Music volume</label><input type="number" step={0.01} min={0} max={1} value={s.musicVolume} onChange={(e) => set({ musicVolume: Number(e.target.value) })} /></div>
        </div>
      </div>
      <div className="card">
        <h3>Google Sheet log</h3>
        <label>Sheet ID (from the sheet URL: docs.google.com/spreadsheets/d/<b>THIS_PART</b>/edit)</label>
        <input value={s.sheetId} onChange={(e) => set({ sheetId: e.target.value })} />
        <p className="muted small">Tabs “Runs” and “Activity” are created automatically.</p>
      </div>
      <button className="primary" onClick={async () => { try { const r = await api("/api/settings", { method: "PUT", body: JSON.stringify(s) }); setS(r.settings); t.ok("Settings saved"); } catch (e) { t.err(e); } }}>Save settings</button>
    </>
  );
}

// ---------------------------------------------------------------- Team
function Team({ t }: { t: Toast }) {
  const [users, setUsers] = useState<any[] | null>(null);
  const [f, setF] = useState({ email: "", name: "", password: "", role: "user" });
  const load = useCallback(() => api("/api/users").then((r) => setUsers(r.users)).catch(t.err), [t.err]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <h2 style={{ marginTop: 8 }}>Team</h2>
      <div className="card">
        <h3>Add a user</h3>
        <p className="muted small">Users can create and run their own schedules, upload studio assets and see all jobs. Only owners can change brand settings, connections and the team.</p>
        <div className="row">
          <div><label>Email</label><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div><label>Name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><label>Temporary password (8+)</label><input value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          <div><label>Role</label><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="user">user</option><option value="owner">owner</option></select></div>
        </div>
        <button className="primary" style={{ marginTop: 10 }} onClick={async () => { try { await api("/api/users", { method: "POST", body: JSON.stringify(f) }); setF({ email: "", name: "", password: "", role: "user" }); t.ok("User added"); load(); } catch (e) { t.err(e); } }}>Add user</button>
      </div>
      <div className="card">
        <table><tbody>
          {users?.map((u) => (
            <tr key={u.id}><td><b>{u.name}</b><div className="muted small">{u.email}</div></td><td>{u.role}</td><td className="muted small hide-sm">added by {u.createdBy}</td>
              <td style={{ textAlign: "right" }}><button className="danger" onClick={async () => { if (!confirm(`Remove ${u.email}?`)) return; await api(`/api/users?id=${u.id}`, { method: "DELETE" }).catch(t.err); load(); }}>Remove</button></td></tr>
          ))}
          {users && !users.length && <tr><td className="muted">Only the owner (from env) so far.</td></tr>}
        </tbody></table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Health
function Health() {
  const [r, setR] = useState<{ ok: boolean; checks: { name: string; ok: boolean; detail: string; fix?: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async () => {
    setBusy(true);
    try { setR(await api("/api/health")); } catch (e) { setR({ ok: false, checks: [{ name: "health", ok: false, detail: String((e as Error).message) }] }); } finally { setBusy(false); }
  }, []);
  useEffect(() => { run(); }, [run]);
  const score = useMemo(() => (r ? `${r.checks.filter((c) => c.ok).length}/${r.checks.length}` : ""), [r]);
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <h2 style={{ margin: 0 }}>Health check {score && <span className="muted small">{score} passing</span>}</h2>
        <button style={{ flex: "0 0 auto" }} disabled={busy} onClick={run}>{busy ? "Checking…" : "Re-run"}</button>
      </div>
      <p className="muted small">Live tests against every service with the real credentials. Fix every red line before switching schedules to Live.</p>
      {r?.checks.map((c) => (
        <div key={c.name} className="card">
          <span className={c.ok ? "ok-dot" : "bad-dot"} /><b>{c.name}</b>
          <div className="small">{c.detail}</div>
          {!c.ok && c.fix && <div className="small" style={{ color: "var(--warn)" }}>Fix: {c.fix}</div>}
        </div>
      ))}
    </>
  );
}

export type { Platform };
