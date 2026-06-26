# Security Notes

- Never commit `.env`, API keys, SSH private keys, browser cookies, or Sentaurus license details.
- Keep host-side `ENABLE_REAL_JOBS=0` until the legacy `/api/runs/:id/jobs` path has explicit allowlists and cancellation logic.
- VM Agent chat execution must stay constrained to `<SENTAURUS_RUN_REQUEST>`: safe basenames only, fixed run base, fixed file extensions, and fixed Sentaurus tool argv forms. Do not add raw shell execution.
- Do not expose this service to the public internet without HTTPS and stronger auth.
- The server refuses to bind to `0.0.0.0` with the default auth token and requires a longer token in that mode.
- Treat uploaded TCAD files as private research artifacts.
- Do not pass raw user text into a shell command.
- Do not pass LLM output into a shell command. If the LLM requests execution, parse structured JSON and map it to fixed argv arrays.
- Prefer generated run IDs and fixed base directories for local/remote paths.
- Uploaded/downloaded file names are constrained to safe basenames. Do not weaken this without adding tests.
- Browser API responses avoid exposing `localDir`; keep absolute backend paths server-side.
