import { useEffect, useState } from "react";
import type { ChatMessage, RunSummary, VmStatus } from "@sentaurus-agent/shared";
import { createRun, getAuthToken, getHealth, getVmStatus, listRuns, sendChat, setAuthToken } from "./lib/api.js";

export default function App() {
  const [auth, setAuth] = useState(getAuthToken());
  const [health, setHealth] = useState<string>("checking...");
  const [vm, setVm] = useState<VmStatus | null>(null);
  const [vmLoading, setVmLoading] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "system",
      createdAt: new Date().toISOString(),
      content: "Welcome. Configure AUTH_TOKEN and LLM/Sentaurus SSH settings in .env, then test VM status."
    }
  ]);
  const [chatInput, setChatInput] = useState("帮我检查 Sentaurus VM 是否连通，并说明下一步应该怎么跑 SDE/SDevice。 ");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getHealth().then((h) => setHealth(`${h.service} OK @ ${h.time}`)).catch((err) => setHealth(String(err)));
  }, []);

  async function saveToken() {
    setAuthToken(auth);
    await refreshRuns();
  }

  async function refreshVm() {
    setVmLoading(true);
    try {
      setVm(await getVmStatus());
    } finally {
      setVmLoading(false);
    }
  }

  async function refreshRuns() {
    const result = await listRuns();
    setRuns(result.runs);
  }

  async function handleChat() {
    const text = chatInput.trim();
    if (!text) return;
    setBusy(true);
    const user: ChatMessage = { id: `local_${Date.now()}`, role: "user", content: text, createdAt: new Date().toISOString() };
    setMessages((prev) => [...prev, user]);
    setChatInput("");
    try {
      const response = await sendChat(text);
      setMessages((prev) => [...prev, response.message]);
    } catch (err) {
      setMessages((prev) => [...prev, { id: `err_${Date.now()}`, role: "assistant", content: String(err), createdAt: new Date().toISOString() }]);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateRun() {
    const title = window.prompt("Run title", "Manual TCAD run") || "Manual TCAD run";
    const result = await createRun(title);
    setRuns((prev) => [result.run, ...prev]);
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Sentaurus TCAD · Web Agent</p>
          <h1>Dashboard + Chat Bridge</h1>
          <p className="muted">Host-side web backend, OpenAI-compatible LLM config, SSH bridge to <code>sentaurus-centos7</code>.</p>
        </div>
        <div className="health">{health}</div>
      </section>

      <section className="grid">
        <div className="card">
          <h2>Auth</h2>
          <p className="muted">Paste the AUTH_TOKEN from your local .env. It is stored only in browser localStorage.</p>
          <div className="row">
            <input value={auth} onChange={(e) => setAuth(e.target.value)} placeholder="AUTH_TOKEN" type="password" />
            <button onClick={saveToken}>Save</button>
          </div>
        </div>

        <div className="card">
          <h2>Sentaurus VM</h2>
          <button onClick={refreshVm} disabled={vmLoading}>{vmLoading ? "Checking..." : "Check VM status"}</button>
          {vm && (
            <pre className={vm.ok ? "okbox" : "errbox"}>{JSON.stringify(vm, null, 2)}</pre>
          )}
        </div>

        <div className="card wide">
          <h2>Chat</h2>
          <div className="messages">
            {messages.map((m) => <div key={m.id} className={`msg ${m.role}`}><b>{m.role}</b><span>{m.content}</span></div>)}
          </div>
          <textarea value={chatInput} onChange={(e) => setChatInput(e.target.value)} rows={4} />
          <button onClick={handleChat} disabled={busy}>{busy ? "Thinking..." : "Send"}</button>
        </div>

        <div className="card wide">
          <h2>Runs</h2>
          <div className="row">
            <button onClick={handleCreateRun}>Create run directory</button>
            <button onClick={refreshRuns}>Refresh</button>
          </div>
          <div className="runs">
            {runs.map((run) => (
              <div className="run" key={run.id}>
                <b>{run.title}</b>
                <code>{run.id}</code>
                <span>{run.status}</span>
                <small>{run.localDir}</small>
                <small>{run.remoteDir}</small>
              </div>
            ))}
            {runs.length === 0 && <p className="muted">No runs yet.</p>}
          </div>
        </div>
      </section>
    </main>
  );
}
