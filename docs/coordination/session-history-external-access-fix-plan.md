# Session History and External Access Fix Plan

Date: 2026-07-10

Owner: sentaurus-planner

Status: evidence complete; implementation pending

Scope:

- Session list loading and persistence
- VM message-history loading, compaction, streaming, and failure handling
- Browser access through another hostname, IP address, interface, or reverse proxy
- Local session-root migration and backward compatibility

Non-goals:

- No production code changes are included in this planning task.
- No VM message files or local run directories are rewritten.
- No Git commit is created.

## Executive conclusion

The visible symptom is not caused by one missing frontend refresh. It is the combination of four independently verified defects:

1. **A full selected-session history request is larger than the current SSH transport budget.** The frontend requests `limit=5000`; the backend uploads a generated Python control script with SCP, executes it over a globally serialized SSH queue, and applies a fixed 20-second timeout. On the current VM store (`cursor=5667`), a selected-session request took 25.7 seconds and returned `status.ok=false`, `messages=[]`, `cursor=0`, with `ssh command timed out after 20000ms`.
2. **That transport failure is returned as HTTP 200 and is treated by the web app as a successful empty history.** A fresh browser origin therefore shows no transcript instead of an actionable error, while also resetting the live-stream cursor to zero.
3. **External access is pinned to one development IP and one exact browser origin.** The frontend and backend listen only on `10.6.22.1`; the client API base is compiled as `http://10.6.22.1:5175`; Vite rejects alternate hostnames with HTTP 403; Fastify and both SSE routes emit only `http://10.6.22.1:5174` as the allowed origin.
4. **The session catalog root depends on `process.cwd()`.** The same build returns one session when started from the repository root and two different sessions when started from `apps/server`. An external service, reverse-proxy launcher, or manual start can therefore expose a different session list without changing data.

The repair must address all four. Increasing the history timeout alone would leave empty-success handling, external-origin failures, and cwd-dependent session loss intact.

## Current architecture

The UI calls two independent data sources and joins them only by string equality on the run/session ID:

```text
Browser
  |
  | GET /api/runs
  v
Host run catalog
  apps/server/data/runs/*/manifest.json
  or data/runs/*/manifest.json, depending on process.cwd()

Browser
  |
  | GET /api/vm/agent/messages?sessionId=run_...&limit=5000
  v
Host Fastify backend
  |
  | SCP generated Python + SSH python /tmp/script.py
  v
CentOS VM
  ~/.sentaurus-web-agent/vm-agent/messages.jsonl
```

There is no durable host-side session-to-history index. A local run is visible only if its manifest is under the active `LOCAL_RUN_BASE_ABS`; its chat is visible only if VM messages carry an identical `meta.sessionId`.

## Verified evidence

All observations below were reproduced against the running development services on 2026-07-10.

### Listener and browser reachability

Current listeners:

```text
10.6.22.1:5174  Vite
10.6.22.1:5175  Fastify
```

Observed requests:

| Request | Result |
| --- | --- |
| `http://10.6.22.1:5174/` | HTTP 200 |
| `http://127.0.0.1:5174/` | connection failed |
| `http://10.6.22.1:5175/api/health` | HTTP 200 |
| `http://127.0.0.1:5175/api/health` | connection failed |
| Vite request with `Host: external.example:5174` | HTTP 403 |
| Vite request with `Host: sentaurus.example.internal:5174` | HTTP 403 |

The exact-IP binding prevents access through another local interface. The Vite host check separately prevents access through an alternate DNS hostname even when that hostname resolves to `10.6.22.1`.

### API-base and CORS behavior

The live Vite source resolves the API base to:

```text
http://10.6.22.1:5175
```

Observed CORS responses from `GET` and preflight requests to `/api/runs`:

| Request origin | HTTP status | `Access-Control-Allow-Origin` | Browser outcome |
| --- | ---: | --- | --- |
| `http://10.6.22.1:5174` | 200 / 204 | `http://10.6.22.1:5174` | allowed |
| `http://127.0.0.1:5174` | 200 / 204 | `http://10.6.22.1:5174` | blocked: origin mismatch |
| `http://external.example:5174` | 200 / 204 | `http://10.6.22.1:5174` | blocked: origin mismatch |

The server does not reflect an unvalidated origin; however, it always emits the single configured origin, even for a request from another origin. A browser correctly rejects the response.

The VM-message SSE route and run-log SSE route manually write the same fixed CORS value, so changing only Fastify's CORS registration would not repair streaming.

### Session-root drift

The repository currently contains two valid run roots:

| Root | Run count | IDs |
| --- | ---: | --- |
| `data/runs` | 1 | `run_20260609195117_Os18zS` |
| `apps/server/data/runs` | 2 | `run_20260706071613_QpSWrO`, `run_20260626163724_rDsE4Q` |

The same built `runStore` returned:

```json
{"cwd":"E:\\VSCode\\Sentaurus-agent","count":1,"ids":["run_20260609195117_Os18zS"]}
{"cwd":"E:\\VSCode\\Sentaurus-agent\\apps\\server","count":2,"ids":["run_20260706071613_QpSWrO","run_20260626163724_rDsE4Q"]}
```

The live service was launched through the npm workspace script and currently returns the two runs under `apps/server/data/runs`.

This is deterministic evidence that service-launch location changes the user-visible session list.

### History payload and timeout

The current history store reported a global cursor of `5667`.

A small request succeeded:

```text
GET /api/vm/agent/messages?after=0&limit=50
status.ok=true
messages=50
cursor=5667
```

The selected-session request used by the page failed:

```text
GET /api/vm/agent/messages
  ?after=0
  &limit=5000
  &sessionId=run_20260706071613_QpSWrO

elapsedMs=25729
status.ok=false
messages=0
cursor=0
error="ssh command timed out after 20000ms"
HTTP status=200
```

A global `limit=5000` request reproduced the same empty failure.

This validates that the existing `SESSION_HISTORY_LIMIT=5000` change solved the old truncation limit but exceeded the current transport design.

### Working-tree context

The current working tree already contains the previously planned history-compaction work:

- Route limit increased from 1000 to 5000.
- Full selected-session history is compacted on the host.
- Frontend selected-session history limit is 5000.
- Streaming and worklog grouping changes are present.

The built server files contain those changes, so the timeout result is not explained by stale `dist` output.

## Session-list data flow

### Browser

1. `App` initializes `runs` as an empty array and restores only token/order state from browser-local storage.
2. When `authKey` exists, the startup effect calls `refreshRuns(true)`.
3. `refreshRuns` calls `listRuns`, replaces `runs`, and may select the first result.
4. A second effect also selects the first ordered run if the current selection is absent.
5. Session cards render only from `runs`; VM history cannot create a missing session card.

Relevant code:

- `apps/web/src/App.tsx`
  - `App` state initialization: lines 935-969
  - `refreshRuns`: lines 1334-1341
  - startup auth effect: lines 1992-2000
  - selection reconciliation: lines 1987-1990
  - session rendering: lines 2284-2352
- `apps/web/src/api/runs.ts`
  - `listRuns`: lines 4-6

### Host route and store

1. `GET /api/runs` authenticates and calls `listRuns`.
2. `listRuns` reads directories directly under `config.LOCAL_RUN_BASE_ABS`.
3. Each directory must contain a valid `manifest.json`.
4. Results are sorted by `createdAt`.

Relevant code:

- `apps/server/src/routes/runs.ts`
  - `GET /api/runs`: lines 41-44
- `apps/server/src/services/runStore.ts`
  - base-directory creation: lines 13-15
  - run-directory resolution: lines 33-35
  - `createRun`: lines 70-88
  - `listRuns`: lines 91-106
- `apps/server/src/config.ts`
  - relative `LOCAL_RUN_BASE`: line 21
  - cwd-dependent absolute path: line 38

## Message-history data flow

### Startup ordering

With a saved token, the same effect starts these operations concurrently:

```text
refreshRuns(true)
refreshVm()
handleRefreshVmAgentMessages(false)
open EventSource
```

At that moment `selectedRunId` is normally still null because `refreshRuns` has not completed. The first history call is therefore a global request with `limit=500`, not a selected-session request.

After the run list resolves and a session becomes selected, another effect requests:

```text
after=0
limit=5000
sessionId=<selected run>
```

If that full request times out, the global 500-message bootstrap is the only data available. For an older session, those latest global messages may belong to other sessions, so the selected transcript remains empty or partial.

Relevant code:

- `apps/web/src/App.tsx`
  - limits: lines 135-143
  - `handleRefreshVmAgentMessages`: lines 1205-1219
  - concurrent startup: lines 1992-2000
  - selected-session effect: lines 2146-2163

### Browser request and merge

1. `getVmAgentMessages` adds `after`, `limit`, and optional `sessionId`.
2. The response is accepted whenever HTTP is successful.
3. `handleRefreshVmAgentMessages` and the selected-session effect set VM status and cursor, then merge messages.
4. Neither path rejects `response.status.ok === false`.
5. An empty failed response therefore merges nothing and sets the shared cursor to zero.

Relevant code:

- `apps/web/src/api/vmAgent.ts`
  - `getVmAgentMessages`: lines 30-35
  - SSE URL: lines 37-39
- `apps/web/src/App.tsx`
  - cursor update: lines 1073-1076
  - message merge: lines 1104-1106
  - manual refresh: lines 1205-1219
  - selected-session load: lines 2146-2163

### Host route

1. The route accepts a maximum limit of 5000.
2. It calls `getVmAgentMessages`.
3. It always returns a normal JSON response containing `{ ok: result.status.ok, ...result }`.
4. A VM/SSH failure does not become an HTTP 502/504.

Relevant code:

- `apps/server/src/routes/vmAgent.ts`
  - history limits: lines 16-24
  - `GET /api/vm/agent/messages`: lines 180-188

### SSH and VM store

1. `getVmAgentMessages` calls `callVmAgent` with `operation: "history"`.
2. `callVmAgent` uses `runSshCommandWithInput(..., 20_000)`.
3. `runSshCommandWithInput` writes the entire generated Python script to a temporary file.
4. The script is copied with SCP, then executed with SSH.
5. All SSH work is serialized through one module-level `sshQueue`.
6. VM `read_messages` scans the full JSONL file, filters by `sessionId`, keeps the last `limit` matching messages, and returns the global line cursor.
7. Host compaction happens only after the raw VM JSON payload has crossed SSH, so it does not reduce transfer time or avoid the timeout.

Relevant code:

- `apps/server/src/services/vmAgent.ts`
  - VM root and `messages.jsonl`: lines 2443-2448
  - VM `read_messages`: lines 2508-2533
  - host compaction: lines 3368-3423
  - `callVmAgent`: lines 3489-3500
  - `getVmAgentMessages`: lines 3554-3559
- `apps/server/src/services/sshClient.ts`
  - global queue: line 32
  - SSH execution and timeout: lines 76-180
  - serialized execution: lines 259-269
  - SCP plus SSH script execution: lines 284-314

## Root-cause analysis

### RC-1: Host-side compaction occurs too late

The VM returns up to 5000 raw events. Incremental assistant output may produce hundreds or thousands of delta/worklog records for one user turn. The host compacts only after receiving all raw records.

Consequences:

- transfer volume grows with raw event count rather than visible turn count;
- VM JSON parsing and serialization happen on every full refresh;
- SCP setup plus SSH execution share the same 20-second budget;
- the shared SSH queue adds contention from status, files, sends, artifacts, and history calls;
- a frontend limit intended to prevent truncation now triggers timeout.

This is the primary history-loss defect.

### RC-2: Failure is represented as successful emptiness

`getVmAgentMessages` converts SSH failure into a `VmAgentStatus` with `ok=false`, but the route still returns HTTP 200. The frontend does not branch on `status.ok`.

Consequences:

- the UI cannot distinguish “session has no messages” from “history transport failed”;
- fresh page loads show an empty transcript;
- the shared cursor can be reset to zero;
- SSE reconnect may replay only a bounded recent global batch and cannot reconstruct an old session;
- retry/load indicators do not explain the root failure.

### RC-3: Startup races global and selected history

The initial history request starts before the run list has selected a session. It fetches a global tail of 500 records. The later selected history call is the request that times out.

Consequences:

- recent sessions may look partially correct by accident;
- older sessions remain empty;
- behavior varies with global activity and message distribution;
- an external browser with no existing in-memory message state is more likely to expose the failure.

### RC-4: External access is configured as one exact development origin

The web listener, backend listener, client API base, CORS origin, and SSE CORS headers all assume the same hard-coded IP pair.

Consequences:

- another local interface cannot reach either listener;
- an alternate hostname receives Vite HTTP 403;
- a browser loaded from another accepted frontend origin would still call the fixed API IP;
- REST preflight and SSE responses fail browser origin checks;
- localStorage token and session order do not transfer to the new origin.

### RC-5: Session storage is resolved relative to launch cwd

`LOCAL_RUN_BASE_ABS` uses `path.resolve(process.cwd(), parsed.LOCAL_RUN_BASE)`.

Consequences:

- npm workspace start, root-level `node`, Windows service, test runner, and process manager can expose different catalogs;
- switching deployment method appears to delete or restore sessions;
- a fix that merely changes path resolution would hide the two currently active workspace sessions unless data is migrated first.

### RC-6: Session catalog and history have no reconciliation contract

The local manifest is the session-list authority. VM JSONL is the message authority. The only link is `run.id === message.meta.sessionId`.

Consequences:

- VM history can exist without a visible local session;
- a local session can exist with no VM history;
- deleting a local session intentionally leaves VM messages unreachable from the normal UI;
- moving only one storage root breaks the join;
- there is no diagnostic report showing orphaned local or VM session IDs.

## Required file and function changes

The following is the minimal production change surface for an implementation task.

| Priority | File | Function/config | Required change |
| --- | --- | --- | --- |
| P0 | `apps/server/src/services/vmAgent.ts` | VM `read_messages` / new compact-history helper | Filter and compact selected-session full history on the VM before JSON serialization; preserve raw incremental reads for `after>0`. |
| P0 | `apps/server/src/services/vmAgent.ts` | `callVmAgent`, `getVmAgentMessages` | Use a history-specific timeout/response budget; reject failed history instead of returning empty success; keep host compaction as legacy fallback. |
| P0 | `apps/server/src/routes/vmAgent.ts` | history route | Return 502/504 with structured error metadata when VM history fails. |
| P0 | `apps/web/src/App.tsx` | startup auth effect | Await run selection before selected-session history bootstrap; do not rely on a global tail to hydrate the selected transcript. |
| P0 | `apps/web/src/App.tsx` | `handleRefreshVmAgentMessages`, selected-session effect | Check `response.status.ok`; preserve the last valid cursor/messages on failure; expose retryable history error state. |
| P0 | `apps/server/src/config.ts` | `LOCAL_RUN_BASE_ABS` | Resolve relative paths from a stable repository/data root, not `process.cwd()`. |
| P0 | migration utility or documented one-time command | new | Inventory and merge both existing run roots without overwriting duplicate IDs. |
| P1 | `apps/web/src/api/client.ts` | `API_BASE`, `apiUrl` | Prefer same-origin relative API URLs for deployed access; support explicit runtime/development override. |
| P1 | `apps/server/src/config.ts` | `CORS_ORIGIN` replacement | Parse an exact allowlist, not one string. |
| P1 | `apps/server/src/index.ts` | CORS registration | Validate request origins through the shared allowlist. |
| P1 | `apps/server/src/routes/vmAgent.ts` | message SSE route | Emit the validated request origin; do not write a fixed origin. |
| P1 | `apps/server/src/routes/runs.ts` | log SSE route | Emit the validated request origin; do not write a fixed origin. |
| P1 | `apps/web/package.json` or Vite config | dev/preview commands | Make bind address configurable and allow only explicitly configured development hostnames. |
| P1 | `scripts/start-dev.ps1` | startup URLs/env | Pass the configured host/API/origin values consistently instead of printing fixed URLs. |
| P1 | `scripts/web-dev-watchdog.ps1` | parameters and `Start-WebDev` | Separate bind address, public frontend origin, and API base; validate them in status output. |
| P2 | `apps/server/src/routes/runs.ts` or diagnostics route | new reconciliation report | Report canonical run root, run IDs, VM cursor, and orphan counts without exposing message content. |

## Minimal repair design

### Phase 1: Make history failure explicit

This phase is the smallest safe behavioral correction and should land before external-access expansion.

1. Add a structured history error:

```json
{
  "ok": false,
  "error": "VM_HISTORY_TIMEOUT",
  "retryable": true,
  "cursor": 5667
}
```

2. Return HTTP 504 for the SSH history timeout and HTTP 502 for other VM bridge failures.
3. Do not replace a known cursor with zero when a request fails.
4. Add frontend state per selected session:

```text
idle | loading | ready | empty | failed | truncated
```

5. Render “History failed to load — Retry” instead of “No messages in this session.”
6. Keep live SSE connected if only the full-history bootstrap fails.

This phase prevents silent data-loss presentation even before payload optimization is complete.

### Phase 2: Compact before transport

For `operation=history`, `after=0`, and a non-empty `sessionId`:

1. Scan `messages.jsonl` once.
2. Filter by exact `meta.sessionId`.
3. Group stream events by:

```text
turnId + (targetMessageId || streamId || assistant_<turnId>)
```

4. Compact delta/done events into one assistant message.
5. Preserve user, normal agent, progress/worklog, run-final, diagnostic, and attachment messages.
6. De-duplicate attachments by source/run/category/path.
7. Return compacted records plus the global cursor.
8. Enforce a response byte budget and return `truncated=true` with a continuation token if exceeded.

The existing host `compactSessionHistory` remains as a compatibility fallback for older VM control scripts or mixed-format history.

The 20-second timeout may be raised to a configurable history timeout as a safety margin, but timeout increase is not the primary fix.

### Phase 3: Sequence startup deterministically

Change browser bootstrap order:

```text
validate token
  -> load run list
  -> select requested/first session
  -> load selected session history
  -> start global incremental stream from returned cursor
```

Rules:

- Global history is not a substitute for selected history.
- Session switches cancel or ignore stale responses.
- A selected-session response updates only that session's cache.
- The global cursor is advanced only by successful responses.
- A failed selected history request leaves existing messages intact.

### Phase 4: Stabilize the run root

Define a repository-stable base:

```text
repoRoot = path resolved from config module location
canonicalRunRoot = absolute LOCAL_RUN_BASE
  or repoRoot + relative LOCAL_RUN_BASE
```

Do not use `process.cwd()` for persistent data.

Recommended canonical root:

```text
E:\VSCode\Sentaurus-agent\data\runs
```

The choice is less important than stability, but migration must happen before switching because the two active user sessions currently live under `apps/server/data/runs`.

### Phase 5: Support external access safely

Preferred deployment:

```text
https://sentaurus.example.internal/
  /          -> static web app
  /api/*     -> Fastify
  SSE paths  -> Fastify with buffering disabled
```

Benefits:

- browser API URLs are relative;
- REST and SSE are same-origin;
- CORS is not required for the primary deployment;
- one hostname owns one localStorage token;
- TLS and access controls are centralized.

Development fallback:

- configurable web bind address;
- configurable backend bind address;
- exact `CORS_ORIGINS` allowlist;
- explicit Vite `allowedHosts`;
- no wildcard origin with bearer authentication;
- existing strong-token guard retained when backend binds to `0.0.0.0`.

## Migration and compatibility

### Local run-root migration

Current inventory contains three unique run IDs across two roots.

Required migration behavior:

1. Run in dry-run mode first.
2. Inventory both:
   - `data/runs`
   - `apps/server/data/runs`
3. Validate every manifest ID against its directory name.
4. Compute file hashes for duplicate IDs before any merge.
5. Copy unique runs into the canonical root.
6. Never overwrite a conflicting duplicate automatically.
7. Produce a JSON/text report containing source, destination, ID, action, and conflict.
8. Keep the legacy roots unchanged until the new service has passed acceptance tests.
9. Roll back by restoring the old `LOCAL_RUN_BASE` and launcher; no manifest format change is required.

Compatibility option for one release:

- canonical root is primary;
- legacy workspace root is read-only fallback;
- duplicate IDs prefer canonical and emit a warning;
- creation always writes only to canonical;
- fallback is removed after migration verification.

### VM message compatibility

No destructive VM migration is required.

- Existing JSONL messages remain source-of-truth.
- Old unscoped messages keep the current limited legacy pairing behavior.
- Old normal agent messages pass through unchanged.
- New streamed turns are compacted during reads only.
- Host-side compaction remains available for old VM protocol responses.
- VM history is never rewritten by a browser refresh.

### Browser-origin compatibility

`localStorage` is origin-scoped by browser design.

- `sentaurus_auth_token` cannot and should not be silently copied from `http://10.6.22.1:5174` to another hostname.
- Users must enter the token once on the new canonical origin.
- `sentaurus_session_order` is cosmetic; losing it must not hide sessions because the authoritative list comes from `/api/runs`.
- The UI should diagnose “token missing”, “API unreachable”, “origin rejected”, and “history timeout” separately.

### Delete semantics

Current deletion removes the local run and local files only. It does not remove VM JSONL history.

Keep this behavior during the fix to avoid a destructive protocol change. Document it as:

```text
Delete local session catalog/files; retain VM audit/history records.
```

Recovered/orphan VM sessions may be exposed later as a read-only diagnostics feature, not automatically recreated during this repair.

## Test and acceptance matrix

### Unit tests

| ID | Area | Scenario | Expected |
| --- | --- | --- | --- |
| U1 | Config | Resolve relative `LOCAL_RUN_BASE` from repo root under two different cwd values | identical absolute path |
| U2 | CORS | Allowed exact origin | origin returned exactly |
| U3 | CORS | Unlisted origin | rejected or no ACAO header |
| U4 | CORS | Empty/non-browser Origin | follows explicit server policy |
| U5 | History | Delta plus terminal message | one compacted assistant message |
| U6 | History | Delta stream without terminal | one streaming draft |
| U7 | History | Mixed old/new message formats | old messages preserved exactly once |
| U8 | History | Attachments across deltas | de-duplicated attachments retained |
| U9 | History | Response exceeds byte budget | `truncated=true` plus continuation |
| U10 | Web state | Failed history response | cursor and previous messages unchanged |
| U11 | Web state | Stale response after session switch | response ignored |

### Backend integration tests

| ID | Scenario | Expected |
| --- | --- |
| I1 | Start backend from repository root | same run IDs as workspace start |
| I2 | Start backend from `apps/server` | same run IDs as root start |
| I3 | VM store with 5667+ raw events, selected-session full load | HTTP 200, `status.ok=true`, compacted result within configured SLA |
| I4 | Force SSH timeout | HTTP 504, structured retryable error, nonzero last-known cursor if available |
| I5 | VM unavailable | HTTP 502, no fake empty-success payload |
| I6 | Incremental `after>0` request | raw live delta events preserved |
| I7 | Allowed external origin REST preflight | correct matching ACAO |
| I8 | Disallowed origin REST preflight | blocked |
| I9 | Allowed external origin SSE | stream opens with matching ACAO and no proxy buffering |
| I10 | Disallowed origin SSE | stream rejected |

### Migration tests

| ID | Scenario | Expected |
| --- | --- |
| M1 | Two roots with unique IDs | union copied to canonical root |
| M2 | Duplicate ID with identical files | one canonical copy, reported as duplicate-identical |
| M3 | Duplicate ID with different manifests/files | migration stops for that ID and reports conflict |
| M4 | Invalid manifest or directory-name mismatch | skipped and reported; no overwrite |
| M5 | Rollback after migration | old launcher/root still serves original data |

### Browser end-to-end tests

| ID | Entry URL | Scenario | Expected |
| --- | --- | --- | --- |
| E1 | canonical same-origin URL | first token entry | session list loads; selected history loads |
| E2 | canonical same-origin URL | refresh long streamed session | complete transcript, no raw delta flood |
| E3 | canonical same-origin URL | switch rapidly between sessions | no cross-session history contamination |
| E4 | allowed development IP | REST plus SSE | both work |
| E5 | allowed development hostname | page, REST, SSE | all work; no Vite 403 |
| E6 | disallowed hostname/origin | access attempt | explicit rejection |
| E7 | new browser origin with no token | initial page | token-required state, not empty session state |
| E8 | backend reachable but VM history times out | selected session | visible retryable error; existing list remains |
| E9 | session with no VM messages | selected session | true empty state only after successful history response |
| E10 | VM messages for deleted local run | normal UI | not shown as active local session; diagnostics reports orphan |

### Security tests

| ID | Scenario | Expected |
| --- | --- |
| S1 | `HOST=0.0.0.0` with default token | startup refused |
| S2 | `HOST=0.0.0.0` with short token | startup refused |
| S3 | wildcard CORS with bearer auth | configuration rejected or test fails |
| S4 | unlisted Origin with valid token | browser access still blocked |
| S5 | path traversal in session/run ID | rejected by existing validators |
| S6 | migration conflict | no destructive overwrite |

## Acceptance criteria

The implementation is complete only when all of the following are true:

1. Starting the same backend build from the repository root and `apps/server` produces the same session IDs.
2. The two active sessions currently under `apps/server/data/runs` remain visible after canonical-root migration.
3. No run directory is overwritten or deleted by migration.
4. A selected-session request against a VM store with at least 5667 raw records succeeds without returning raw unbounded history.
5. Full selected-session history returns complete visible turns, not hundreds of delta records.
6. Live incremental streaming still emits raw deltas and finalizes the same assistant turn.
7. An SSH timeout produces HTTP 504 and a visible retry action, not HTTP 200 with an empty transcript.
8. A failed history load does not reset a valid cursor or erase existing messages.
9. Initial startup selects a run before performing the authoritative selected-session history load.
10. A true empty session is shown only after a successful history response with zero matching messages.
11. The canonical external URL loads the web app, session list, selected history, downloads, and both SSE streams.
12. An allowed alternate hostname does not receive Vite HTTP 403.
13. Allowed origins receive their exact matching ACAO value; disallowed origins are rejected.
14. The client no longer depends on a compiled `10.6.22.1` API URL in the deployed same-origin path.
15. A user entering the token on the canonical origin can refresh and retain access on that origin.
16. The default-token and short-token protections remain active for broad backend binds.
17. A reconciliation diagnostic can identify local-only and VM-only session IDs without exposing message content.

## Implementation backlog

### P0: correctness and data safety

1. Add explicit history 502/504 error contract.
2. Preserve cursor/messages on failed history calls.
3. Move selected-session compaction before SSH response serialization.
4. Add response-size budget and continuation metadata.
5. Sequence run selection before selected history bootstrap.
6. Make `LOCAL_RUN_BASE_ABS` cwd-independent.
7. Implement and dry-run local-root migration.

### P1: external access

1. Define canonical same-origin deployment URL.
2. Change deployed API base to relative URLs.
3. Add exact multi-origin validation for development.
4. Reuse origin validation in REST and SSE.
5. Make Vite bind address and allowed hosts configurable.
6. Update startup/watchdog diagnostics.
7. Add browser-facing connectivity/auth/history diagnostics.

### P2: operability

1. Add run-root and VM-history reconciliation diagnostics.
2. Add history latency, raw count, compacted count, payload bytes, and timeout metrics.
3. Add read-only orphan-session reporting.
4. Document local-delete versus VM-history-retention semantics.

## Rollout order

1. Land explicit history failure handling and cursor preservation.
2. Land VM-side compact selected-session history with host fallback.
3. Run long-history integration tests against a copy or fixture of the current 5667-record store.
4. Inventory and migrate both local run roots.
5. Switch to stable path resolution.
6. Deploy same-origin external access or the exact-origin development configuration.
7. Run the complete browser, migration, and security matrix.
8. Keep old run roots and old launcher configuration until one full verification cycle passes.

## Rollback

- History changes are read-time shaping only; disable VM-side compaction and retain host fallback if needed.
- Restore the previous frontend limit only as an emergency mitigation, not as the final fix.
- Point `LOCAL_RUN_BASE` back to the previous root if catalog verification fails.
- Keep migrated copies and source roots until checksums and visible session counts match.
- Revert the reverse-proxy/DNS entry to the original `10.6.22.1` development URL if external routing fails.

No rollback step requires deleting VM history or local run directories.
