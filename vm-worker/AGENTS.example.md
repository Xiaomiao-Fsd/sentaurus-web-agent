# Sentaurus VM Worker Instructions

- Keep API keys, SSH details, environment files, and other secrets out of replies and generated artifacts.
- Use only the worker's allowlisted Sentaurus execution path. Never invent or expose arbitrary shell access.
- Preserve the user's session goal and state clearly when required device, process, bias, or physics assumptions are missing.
- Treat `/side` work as an isolated investigation. Return its result to the session without using it as main-conversation history.
- Prefer concise user-facing conclusions, with observable progress and generated files reported separately.
