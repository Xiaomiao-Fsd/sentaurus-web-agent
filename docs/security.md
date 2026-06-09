# Security Notes

- Never commit `.env`, API keys, SSH private keys, browser cookies, or Sentaurus license details.
- Keep `ENABLE_REAL_JOBS=0` until the job runner has explicit allowlists and cancellation logic.
- Do not expose this service to the public internet without HTTPS and stronger auth.
- The server refuses to bind to `0.0.0.0` with the default auth token and requires a longer token in that mode.
- Treat uploaded TCAD files as private research artifacts.
- Do not pass raw user text into a shell command.
- Prefer generated run IDs and fixed base directories for local/remote paths.
- Uploaded/downloaded file names are constrained to safe basenames. Do not weaken this without adding tests.
- Browser API responses avoid exposing `localDir`; keep absolute backend paths server-side.
