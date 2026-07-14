# Session History VM / Deployment Acceptance

Date: 2026-07-10

Scope: final acceptance for the existing fixed-host deployment at `10.6.22.1`, including browser/web/backend routing, Windows-to-VM SSH bridge behavior, VM worker status, session catalog visibility, full selected-session history, incremental history paging, metadata preservation, and SSH process cleanup.

## Decision

**PASS for the current `10.6.22.1:5174/5175` deployment and session-history VM path.**

This acceptance does not expand the deployment to arbitrary hostnames, reverse proxies, or additional origins. The P1 same-origin, CORS allowlist, Vite `allowedHosts`, and stream-ticket/query-token work identified by the review remains a separate deployment scope.

## Constraints Observed

- No run history or legacy run data was deleted.
- No Git reset, checkout, commit, or token rotation was performed.
- The existing `AUTH_TOKEN` value was retained and is not reproduced in this report.
- Production changes were limited to the startup compatibility guard and its targeted regression test.

## Minimal Compatibility Fix

The reviewer-added auth guard blocked the existing `.env` because `HOST=10.6.22.1` is non-loopback while the retained legacy token does not meet the new non-loopback policy.

The guard now preserves pre-fix compatibility only for the exact existing bind address `10.6.22.1`. Loopback behavior remains unchanged, and every other non-loopback address, including wildcard and other private addresses, still rejects the default token and requires at least 24 characters.

Files changed for this acceptance:

- `apps/server/src/config.ts`
- `apps/server/test/sessionHistory.test.ts`

## Static Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Session-history tests | PASS | `npm run test:session-history`: 12/12 passed |
| Typecheck | PASS | `npm run typecheck` completed for shared, server, and web |
| Build | PASS | `npm run build` completed; only existing `lucide-react` `"use client"` warnings |
| Migration dry-run | PASS | canonical existing: 3; duplicate identical: 2; conflict: 0; invalid: 0 |
| Startup config probe | PASS | current `.env` imports successfully without changing the token |

## Deployment and Environment

The final service restart was performed through `start-dev.bat`.

| Item | Accepted value/result |
| --- | --- |
| Frontend listener | `10.6.22.1:5174` |
| Backend listener | `10.6.22.1:5175` |
| Frontend HTTP | 200 |
| Backend `/api/health` | 200 |
| `HOST` | `10.6.22.1` |
| `PORT` | `5175` |
| `CORS_ORIGIN` | `http://10.6.22.1:5174` |
| CORS GET / preflight | 200 / 204 with the configured exact origin |
| `VITE_API_BASE` | not explicitly set; effective dev module base confirmed as `http://10.6.22.1:5175` |
| `SENTAURUS_SSH_TARGET` | configured alias retained |
| VM agent status | HTTP 200 in 6.134 s; connected and worker running |
| VM status | HTTP 200 in 2.359 s; top-level `ok=true` |

## Session Catalog

`GET /api/runs` returned HTTP 200 in 51 ms and exposed all three canonical sessions:

1. `run_20260706071613_QpSWrO`
2. `run_20260626163724_rDsE4Q`
3. `run_20260609195117_Os18zS`

## Real Selected History

Accepted request:

`GET /api/vm/agent/messages?after=0&limit=5000&sessionId=run_20260706071613_QpSWrO`

| Metric | Result |
| --- | ---: |
| HTTP status | 200 |
| Elapsed | 8.316 s |
| `ok` / `status.ok` | true / true |
| Returned messages | 597 |
| Global cursor | 5667 |
| Raw selected records | 968 |
| Compacted records | 597 |
| VM-side history compacted | true |
| Truncated | false |
| Transport uncompressed | 390,935 bytes |
| Transport compressed | 37,537 bytes |
| Cross-session messages | 0 |

The selected history is non-empty, completes inside the configured 45-second history timeout, and no longer returns a false empty success.

## Incremental `after>0`

The live API was checked from cursor 5547:

- Baseline request with `limit=12` returned 12 ordered sequences.
- Page 1 with `limit=5` returned 5 records and cursor 5552.
- Page 2 with `after=5552&limit=7` returned the next 7 records and cursor 5559.
- Page 1 plus page 2 exactly matched the baseline sequence list.
- All returned sequence values were unique and strictly increasing.

Result: **no skipped incremental events and no premature cursor jump to EOF**.

## Context Regression Checks

The real selected history and the 12-test regression suite jointly confirmed:

| Context | Real-history evidence |
| --- | ---: |
| Artifact-bearing messages | 2 |
| Attachments | 2 |
| Attachments missing source/run/path context | 0 |
| Progress/worklog-bearing messages | 384 |
| Output/run-context messages | 318 |
| Messages carrying selected session context | 597 |
| Invalid/mixed session context | 0 |

The targeted tests also verify artifact JSON, progress/output fields, host normalization, failure cursor preservation, hydration ordering, stale-response rejection, and raw incremental event preservation.

## SSH Process Acceptance

During an active browser SSE connection, one or two short-lived `ssh.exe` processes were commonly present as the backend SSH/ProxyJump chain. Repeated samples showed rotating PIDs, ages below three seconds, a live backend or outer-SSH parent, and one sample with no SSH process between polls.

- Stale parentless `ssh.exe` / `scp.exe` processes older than 15 seconds: **0**
- Long-lived detached acceptance-probe processes: **0**
- Windows timeout process-tree cleanup test: **PASS**

The observed processes are normal serialized polling activity and terminate between requests; no persistent orphan remains.

## Residual Risks

- The deployment remains intentionally bound to the existing `10.6.22.1` host and exact frontend origin.
- General external-hostname/reverse-proxy acceptance still requires the P1 work listed in the review report.
- The retained token remains a legacy deployment credential. It was not rotated per instruction; the compatibility exception is restricted to the exact existing host, so security is not reduced below the pre-fix deployment.
- Stream URLs still use the existing query-token design; log redaction or stream-ticket work remains part of the separate P1 security scope.

## Final Acceptance Matrix

| Requirement | Result |
| --- | --- |
| Session-history tests | PASS |
| Typecheck | PASS |
| Build | PASS |
| Migration dry-run | PASS |
| Real selected history non-empty and timed | PASS |
| `after>0` does not skip events | PASS |
| Artifact/progress/output/session context preserved | PASS |
| Three sessions visible | PASS |
| No orphan SSH/SCP processes | PASS |
| Restart through `start-dev.bat` | PASS |
| Ports 5174/5175 and HTTP endpoints | PASS |
| No history deletion/reset/commit/token rotation | PASS |
