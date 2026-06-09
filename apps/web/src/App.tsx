import { useEffect, useState } from "react";
import type { ChatMessage, RunDetail, RunFile, RunSummary, VmAgentMessage, VmAgentStatus, VmStatus } from "@sentaurus-agent/shared";
import {
  cancelRun,
  connectVmAgent,
  createRun,
  downloadUrl,
  getAuthToken,
  getHealth,
  getRun,
  getVmAgentStatus,
  getVmStatus,
  listRuns,
  logStreamUrl,
  prepareRemoteRun,
  sendChat,
  sendVmAgentMessage,
  setAuthToken,
  submitRunJob,
  uploadRunFile
} from "./lib/api.js";

export default function App() {
  const [auth, setAuth] = useState(getAuthToken());
  const [health, setHealth] = useState<string>("checking...");
  const [vm, setVm] = useState<VmStatus | null>(null);
  const [vmLoading, setVmLoading] = useState(false);
  const [vmAgent, setVmAgent] = useState<VmAgentStatus | null>(null);
  const [vmAgentMessages, setVmAgentMessages] = useState<VmAgentMessage[]>([]);
  const [vmAgentInput, setVmAgentInput] = useState("hello from web");
  const [vmAgentBusy, setVmAgentBusy] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [runLog, setRunLog] = useState("");
  const [runAction, setRunAction] = useState<string | null>(null);
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

  async function refreshVmAgent() {
    setVmAgentBusy(true);
    try {
      setVmAgent(await getVmAgentStatus());
    } finally {
      setVmAgentBusy(false);
    }
  }

  async function handleConnectVmAgent() {
    setVmAgentBusy(true);
    try {
      const response = await connectVmAgent();
      setVmAgent(response.status);
      if (response.message) setVmAgentMessages((prev) => [...prev, response.message!]);
    } catch (err) {
      setVmAgentMessages((prev) => [...prev, { id: `vm_err_${Date.now()}`, role: "system", content: String(err), createdAt: new Date().toISOString() }]);
    } finally {
      setVmAgentBusy(false);
    }
  }

  async function handleVmAgentMessage() {
    const text = vmAgentInput.trim();
    if (!text) return;
    setVmAgentBusy(true);
    const user: VmAgentMessage = { id: `vm_user_${Date.now()}`, role: "user", content: text, createdAt: new Date().toISOString() };
    setVmAgentMessages((prev) => [...prev, user]);
    setVmAgentInput("");
    try {
      const response = await sendVmAgentMessage(text);
      if (response.status) setVmAgent(response.status);
      setVmAgentMessages((prev) => [...prev, response.message]);
    } catch (err) {
      setVmAgentMessages((prev) => [...prev, { id: `vm_err_${Date.now()}`, role: "system", content: String(err), createdAt: new Date().toISOString() }]);
    } finally {
      setVmAgentBusy(false);
    }
  }

  async function refreshRuns() {
    const result = await listRuns();
    setRuns(result.runs);
    if (!selectedRunId && result.runs[0]) setSelectedRunId(result.runs[0].id);
  }

  async function refreshRunDetail(id = selectedRunId) {
    if (!id) return;
    const detail = await getRun(id);
    setRunDetail(detail);
    setSelectedRunId(detail.run.id);
  }

  useEffect(() => {
    if (!selectedRunId || !auth) return;
    void refreshRunDetail(selectedRunId).catch((err) => setRunLog((prev) => `${prev}\n[detail error] ${String(err)}`));
    const events = new EventSource(logStreamUrl(selectedRunId));
    events.addEventListener("log", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { chunk: string };
      setRunLog((prev) => prev + data.chunk);
    });
    events.addEventListener("error", () => events.close());
    return () => events.close();
    // auth intentionally reconnects the stream after token save.
  }, [selectedRunId, auth]);

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
    setSelectedRunId(result.run.id);
    await refreshRunDetail(result.run.id);
  }

  async function handleUpload(fileList: FileList | null) {
    if (!selectedRunId || !fileList?.[0]) return;
    setRunAction("upload");
    try {
      await uploadRunFile(selectedRunId, fileList[0]);
      await refreshRunDetail(selectedRunId);
    } finally {
      setRunAction(null);
    }
  }

  async function handlePrepareRemote() {
    if (!selectedRunId) return;
    setRunAction("prepare");
    try {
      const result = await prepareRemoteRun(selectedRunId);
      window.alert(result.message);
      await refreshRuns();
      await refreshRunDetail(selectedRunId);
    } finally {
      setRunAction(null);
    }
  }

  async function handleSubmitJob() {
    if (!selectedRunId) return;
    setRunAction("submit");
    try {
      const result = await submitRunJob(selectedRunId);
      window.alert(result.message);
    } catch (err) {
      window.alert(String(err));
    } finally {
      setRunAction(null);
    }
  }

  async function handleCancelRun() {
    if (!selectedRunId || !window.confirm("Cancel this run?")) return;
    await cancelRun(selectedRunId);
    await refreshRuns();
    await refreshRunDetail(selectedRunId);
  }

  function renderFileList(files: RunFile[], area: "files" | "artifacts") {
    if (files.length === 0) return <p className="muted">None yet.</p>;
    return files.map((file) => (
      <a className="file-row" key={`${file.kind}:${file.name}`} href={downloadUrl(runDetail!.run.id, area, file.name)} target="_blank" rel="noreferrer">
        <span>{file.name}</span>
        <small>{(file.size / 1024).toFixed(1)} KiB · {new Date(file.modifiedAt).toLocaleString()}</small>
      </a>
    ));
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
          <h2>VM Agent</h2>
          <div className="row wrap">
            <button onClick={handleConnectVmAgent} disabled={vmAgentBusy}>{vmAgentBusy ? "Working..." : "Connect"}</button>
            <button className="secondary" onClick={refreshVmAgent} disabled={vmAgentBusy}>Status</button>
          </div>
          {vmAgent && (
            <pre className={vmAgent.ok ? "okbox" : "errbox"}>{JSON.stringify(vmAgent, null, 2)}</pre>
          )}
          <div className="messages compact">
            {vmAgentMessages.map((m) => <div key={m.id} className={`msg ${m.role}`}><b>{m.role}</b><span>{m.content}</span></div>)}
            {vmAgentMessages.length === 0 && <p className="muted">No VM agent messages yet.</p>}
          </div>
          <div className="row">
            <input value={vmAgentInput} onChange={(event) => setVmAgentInput(event.target.value)} placeholder="Message to VM agent" />
            <button onClick={handleVmAgentMessage} disabled={vmAgentBusy}>{vmAgentBusy ? "Sending..." : "Send"}</button>
          </div>
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
              <button className={`run ${selectedRunId === run.id ? "selected" : ""}`} key={run.id} onClick={() => setSelectedRunId(run.id)}>
                <b>{run.title}</b>
                <code>{run.id}</code>
                <span>{run.status}</span>
                {run.remotePreparedAt && <small>remote prepared: {new Date(run.remotePreparedAt).toLocaleString()}</small>}
                {run.lastError && <small className="danger">{run.lastError}</small>}
              </button>
            ))}
            {runs.length === 0 && <p className="muted">No runs yet.</p>}
          </div>
        </div>

        <div className="card wide">
          <h2>Run detail</h2>
          {!runDetail && <p className="muted">Select or create a run.</p>}
          {runDetail && (
            <div className="detail">
              <div className="detail-head">
                <div>
                  <b>{runDetail.run.title}</b>
                  <code>{runDetail.run.id}</code>
                  <span className={`status ${runDetail.run.status}`}>{runDetail.run.status}</span>
                  {runDetail.run.remoteDir && <small>Remote: {runDetail.run.remoteDir}</small>}
                </div>
                <div className="row wrap">
                  <label className="upload-button">
                    Upload input
                    <input type="file" onChange={(event) => void handleUpload(event.target.files)} />
                  </label>
                  <button onClick={handlePrepareRemote} disabled={!!runAction}>Prepare remote</button>
                  <button onClick={handleSubmitJob} disabled={!!runAction}>Submit job</button>
                  <button className="secondary" onClick={handleCancelRun}>Cancel</button>
                  <button className="secondary" onClick={() => refreshRunDetail()}>Refresh</button>
                </div>
              </div>
              <div className="detail-grid">
                <section>
                  <h3>Input files</h3>
                  {renderFileList(runDetail.files, "files")}
                </section>
                <section>
                  <h3>Artifacts</h3>
                  {renderFileList(runDetail.artifacts, "artifacts")}
                </section>
              </div>
              <h3>Live job log</h3>
              <pre className="logbox">{runLog || "No log lines yet."}</pre>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
