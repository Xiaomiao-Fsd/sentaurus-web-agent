# Sentaurus Agent AMP UI Redesign Plan

## Context

Sentaurus Agent already has the core product capabilities: session management, VM and agent status checks, chat messaging, run progress, output file browsing, logs, and artifact downloads. The main weakness is not the backend flow. The weakness is that the UI styling, component boundaries, and feedback patterns are not yet consistent enough for a long-running TCAD workbench.

This plan uses `ASXS-API/frontend-template` as the visual and interaction reference. The goal is to make Sentaurus Agent feel like a clean internal operations console while preserving the current three-panel agent workflow.

Reference:

- https://github.com/ASXS-API/frontend-template

## Goals

1. Keep the current workbench model: sessions on the left, chat in the center, inspector on the right.
2. Adopt the AMP template's design language: theme tokens, unified buttons, surfaces, status pills, toast, tooltip, and motion transitions.
3. Split the oversized `App.tsx` so layout, UI primitives, business panels, hooks, and utilities are organized by responsibility.
4. Keep the file system orderly. New UI code should be grouped by domain, not accumulated in one file.
5. Preserve and improve one-command startup from the project root.

## What To Borrow From The AMP Template

### Design System

The template centralizes visual rules in CSS tokens and semantic classes instead of scattering hard-coded styling through page code. Sentaurus Agent should follow the same model:

- Use CSS variables or HSL-style tokens for colors.
- Use semantic classes for surfaces, stat cards, toolbars, subnavs, and table shells.
- Support light and dark themes by changing tokens, not component logic.
- Avoid expanding hard-coded colors, shadows, and radii inside business components.

### Control Model

The template models buttons with `variant` and `size`:

```ts
variant: "default" | "outline" | "secondary" | "ghost" | "link" | "destructive";
size: "default" | "sm" | "lg" | "icon";
```

Sentaurus Agent should add a similar `Button` component and use it for consistent hover, focus-visible, disabled, loading, and icon spacing behavior. Other reusable UI primitives should live under `components/ui/`.

### Motion

The template uses `motion` for page transitions, sidebar collapse, toast, staggered lists, and card hover states. Sentaurus Agent should use the same ideas for:

- Left and right panel open/collapse transitions.
- Session list stagger animations.
- Progress panel expand/collapse.
- Context menus, lightbox, and toast enter/exit states.
- Mobile drawer slide-in and backdrop fade.

### Operations Console Layout

The AMP template is dense, quiet, and work-focused. Sentaurus Agent should avoid landing-page or decorative hero patterns. The UI should prioritize repeated agent workflows:

- Top status bar: API, VM, Agent, LLM, Clock.
- Left session rail: search, status, latest message, ordering, menu.
- Center chat area: timeline, progress, composer.
- Right inspector: context usage, VM status, run files, artifacts, logs.

## Proposed File Structure

Target structure:

```text
apps/web/src/
  App.tsx
  main.tsx
  styles.css

  app/
    AppShell.tsx
    TopStatusBar.tsx
    MobileDrawer.tsx
    layoutTypes.ts

  api/
    client.ts
    health.ts
    runs.ts
    vm.ts
    vmAgent.ts

  components/
    ui/
      Button.tsx
      IconButton.tsx
      Surface.tsx
      StatusPill.tsx
      Toast.tsx
      Tooltip.tsx
      Badge.tsx
      Spinner.tsx
      EmptyState.tsx

    sessions/
      SessionSidebar.tsx
      SessionCard.tsx
      SessionContextMenu.tsx
      SessionSearch.tsx

    chat/
      ChatWorkspace.tsx
      ChatHeader.tsx
      ProgressPanel.tsx
      MessageTimeline.tsx
      MessageBubble.tsx
      MessageAttachments.tsx
      Composer.tsx
      QuickPromptBar.tsx

    inspector/
      InspectorPanel.tsx
      ContextUsageCard.tsx
      AgentContextCard.tsx
      RunSummaryCard.tsx
      SessionFilesCard.tsx
      ArtifactBrowser.tsx
      GlobalEventsCard.tsx

    overlays/
      ImageLightbox.tsx
      SessionMenuOverlay.tsx

  hooks/
    useContextUsage.ts
    useMobilePanels.ts
    useRunSelection.ts
    useSessionOrdering.ts
    useVmAgentStream.ts

  lib/
    motion.ts
    storage.ts
    ui.ts

  utils/
    contextUsage.ts
    format.ts
    sessionStatus.ts
```

Structure rules:

1. `App.tsx` should only orchestrate global state and pass data into child components.
2. `components/ui` should contain reusable UI primitives only. No Sentaurus business logic belongs there.
3. `components/sessions`, `components/chat`, and `components/inspector` should map to the three workbench areas.
4. `hooks` should contain reusable state logic such as mobile panels, session ordering, and context usage.
5. `utils` should contain pure functions only. No DOM access and no network calls.
6. `api` should remain the only place where request URLs are defined. Components should not call `fetch` directly.
7. `styles.css` should be reorganized into clear sections: tokens, base, UI primitives, shell, sessions, chat, inspector, overlays, responsive.

## Styling System

### Tokens

Move the current scattered variables toward this structure:

```css
:root {
  --background: 210 30% 98%;
  --foreground: 222 40% 10%;
  --card: 0 0% 100%;
  --card-foreground: 222 40% 10%;
  --primary: 176 78% 32%;
  --primary-foreground: 180 80% 98%;
  --secondary: 210 24% 94%;
  --secondary-foreground: 222 36% 16%;
  --muted: 210 24% 94%;
  --muted-foreground: 215 14% 46%;
  --border: 214 24% 88%;
  --input: 214 24% 88%;
  --ring: 176 78% 32%;
  --destructive: 0 78% 58%;
  --warning: 38 92% 50%;
  --success: 154 70% 36%;
  --radius: 0.625rem;
}

.dark {
  --background: 223 33% 7%;
  --foreground: 210 33% 98%;
  --card: 222 28% 10.5%;
  --card-foreground: 210 33% 98%;
  --primary: 180 82% 58%;
  --primary-foreground: 222 46% 10%;
  --secondary: 222 24% 15%;
  --secondary-foreground: 210 33% 98%;
  --muted: 222 21% 14%;
  --muted-foreground: 214 19% 70%;
  --border: 217 23% 20%;
  --input: 217 21% 18%;
  --ring: 180 82% 58%;
}
```

### Semantic Classes

Add stable semantic classes:

- `.app-shell`
- `.app-topbar`
- `.app-surface`
- `.app-surface-header`
- `.app-surface-body`
- `.app-sidebar`
- `.app-inspector`
- `.app-status-pill`
- `.app-toolbar-row`
- `.app-table-shell`

This keeps visual changes in CSS instead of spreading class-level visual decisions across business components.

## Interaction Changes

### Top Status Bar

The status bar should show:

- API: OK / Offline
- VM: Online / Offline / Checking
- Agent: Running / Stopped / Waiting
- LLM: Configured / Pending
- Clock: OK / Skew

Each status should use `StatusPill` with a state dot, optional icon, and short text. Loading and warning states may use a subtle pulse.

### Left Session Panel

The session panel should support:

- Desktop collapse into a narrow rail.
- Icons and tooltips in collapsed mode.
- Existing drag ordering.
- Motion-based context menu overlay.
- A search field fixed above the list.
- Icon buttons for create, refresh, and utility actions.

### Center Chat Workspace

Keep the current center workflow:

- Current session header.
- Progress panel.
- Message timeline.
- Composer.

Recommended changes:

- Smooth progress panel collapse.
- Unified message bubbles for user, agent, and system messages.
- Move file and image rendering into `MessageAttachments`.
- Convert attach, send, and tools controls into icon buttons with tooltips.

### Right Inspector

Split the inspector into surfaces:

- `ContextUsageCard`
- `AgentContextCard`
- `RunSummaryCard`
- `SessionFilesCard`
- `ArtifactBrowser`
- `GlobalEventsCard`

On narrow screens, the inspector should become a drawer instead of squeezing the chat area.

### Toast

Replace local notices such as `panelNotice` with a global `ToastProvider`.

Toast categories:

- success: token saved, refresh succeeded, upload succeeded.
- error: network failure, VM agent call failed, upload failed.
- info: waiting for agent, SSE reconnecting.

## One-Command Startup

The project root already supports:

```bash
npm run dev
```

This starts both:

- `@sentaurus-agent/server`
- `@sentaurus-agent/web`

Keep this as the official dev entry point.

Recommended commands:

```bash
npm install
npm run dev
```

Default addresses:

- backend: `http://127.0.0.1:3000`
- frontend: `http://127.0.0.1:5174`

### Suggested Root Scripts

The root `package.json` can add:

```json
{
  "scripts": {
    "start:dev": "npm run dev",
    "check": "npm run typecheck",
    "verify": "npm run typecheck && npm run build"
  }
}
```

### Optional Windows Helper

For double-click or direct PowerShell startup, add:

```text
scripts/
  start-dev.ps1
```

Responsibilities:

1. Check that Node.js is available.
2. Check that npm is available.
3. Create `.env` from `.env.example` if `.env` is missing.
4. Run `npm install`.
5. Run `npm run dev`.
6. Print the frontend URL.

Suggested script:

```powershell
$ErrorActionPreference = "Stop"

Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is not installed or not in PATH."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is not installed or not in PATH."
}

if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example. Please review it if VM access is required."
}

npm install
Write-Host "Starting Sentaurus Agent..."
Write-Host "Frontend: http://127.0.0.1:5174"
npm run dev
```

## Implementation Phases

### Phase 1: UI Infrastructure

1. Add UI dependencies: `lucide-react`, `motion`, `class-variance-authority`, `clsx`, and `tailwind-merge` if needed. Add Radix tooltip/dialog only if used.
2. Add `components/ui` primitives.
3. Add `lib/motion.ts`.
4. Add toast provider.
5. Add or document `scripts/start-dev.ps1`.

Validation:

- `npm run typecheck` passes.
- `npm run dev` starts both frontend and backend.

### Phase 2: Tokens And Global Appearance

1. Rewrite the token section in `styles.css`.
2. Normalize button, input, surface, and status pill visuals.
3. Keep the current layout initially. Avoid a large JSX rewrite in this phase.

Validation:

- Main buttons, status pills, and cards share one visual language.
- No obvious text overflow or layout shifting.

### Phase 3: Component Split

1. Extract `TopStatusBar`.
2. Extract `SessionSidebar`.
3. Extract `ChatWorkspace` and `Composer`.
4. Extract `InspectorPanel`.
5. Move pure functions into `utils`.

Validation:

- `App.tsx` is significantly smaller and mainly orchestrates state.
- Existing workflows are still reachable.

### Phase 4: Motion And Mobile

1. Add spring transitions for panel collapse.
2. Convert left and right panels into mobile drawers.
3. Add enter/exit animation for session menu, toast, and lightbox.
4. Add light stagger animation for sessions and inspector cards.

Validation:

- Desktop and mobile layouts are both usable.
- Animations do not interfere with text input or long-running agent tasks.

### Phase 5: Final Cleanup

1. Remove unused styles and dead components.
2. Update README startup instructions.
3. Confirm `.env.example` contains useful setup comments.
4. Run `npm run typecheck`.
5. Run `npm run build`.

## Risks And Constraints

1. Do not copy the entire template into this project. That would bring unnecessary components and Tailwind migration cost.
2. This project currently does not use Tailwind. The first implementation can recreate the AMP style with normal CSS and focused React primitives. A Tailwind migration should be evaluated separately.
3. Do not change backend API contracts as part of the UI redesign.
4. Do not rewrite VM worker logic as part of the UI redesign.
5. Preserve behavior before visual polish. Component extraction should be behavior-equivalent first.

## Completion Criteria

1. Users can run frontend and backend from the project root with `npm run dev`.
2. UI files are organized by layer and domain.
3. Core UI components have consistent hover, focus, disabled, and loading states.
4. Desktop three-panel layout is clear and stable.
5. Mobile left and right panels work as drawers.
6. `npm run typecheck` passes.
7. `npm run build` passes.
8. Existing session, message, VM agent, progress, artifact, and log capabilities are not lost.
