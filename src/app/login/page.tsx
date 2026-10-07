"use client";
import { useState } from "react";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    setBusy(false);
    if (r.ok) location.href = "/";
    else setErr((await r.json().catch(() => ({}))).error ?? "Login failed");
  }
  return (
    <div className="login">
      <div className="brand" style={{ fontSize: 22, marginBottom: 18 }}><i /> Shorts Autopilot</div>
      <form className="card" onSubmit={submit}>
        <label>Email</label>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label>Password</label>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
        <div style={{ marginTop: 14 }}><button className="primary" disabled={busy} style={{ width: "100%", justifyContent: "center" }}>{busy ? "Signing in…" : "Sign in"}</button></div>
      </form>
      <p className="muted small">Owner signs in with OWNER_EMAIL / OWNER_PASSWORD. Team members are added by the owner.</p>
    </div>
  );
}
