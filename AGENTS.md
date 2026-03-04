# NanoBrowse — Agent Guidelines

NanoBrowse is an Electron desktop browser with an AI sidebar powered by GPT-4o-mini. The repo has
two distinct packages:

- **Root** (`/`) — Electron main process (`main.js`, `preload.js`). CommonJS (`"type": "commonjs"`).
- **Renderer** (`renderer/`) — React 19 + Vite 7 frontend. ES Module (`"type": "module"`).

---

## Build / Dev / Lint Commands

All commands are run from the **repo root** unless noted.

### Development

```sh
npm run dev            # starts renderer (Vite :5173) + Electron concurrently
npm run dev:renderer   # renderer only (Vite dev server)
npm run dev:electron   # Electron only (waits for :5173 first via wait-on)
```

### Production build

```sh
npm run build          # builds renderer then packages with electron-builder
npm run build:renderer # Vite production build → renderer/dist/
npm start              # launches the already-built Electron app
```

### Lint

There is no root-level lint script. Run lint from `renderer/`:

```sh
npm run lint --prefix renderer   # ESLint 9 flat config over **/*.{js,jsx}
```

### Tests

**There are no tests in this project.** No test framework, runner, or test files exist.
Do not assume otherwise. If adding tests, use Vitest (already compatible with the Vite setup).

---

## Project Structure

```
NanoBrowse/
├── main.js          # Electron main process (2948 lines) — BrowserWindow, BrowserView,
│                    #   IPC handlers, tool executor, OpenAI agentic loop
├── preload.js       # Context bridge (45 lines) — exposes electronAPI to renderer
├── package.json     # Root package (CommonJS), electron-builder config
├── .env             # NEVER commit — OPENAI_KEY (gitignored, parsed manually at startup)
└── renderer/
    ├── eslint.config.js   # ESLint 9 flat config (29 lines)
    ├── vite.config.js     # Vite config (15 lines)
    ├── package.json       # Renderer package (ES module)
    └── src/
        ├── main.jsx       # React entry point (10 lines)
        ├── App.jsx        # Root component, layout + state (128 lines)
        ├── index.css      # CSS custom properties + global reset (52 lines)
        ├── App.css        # Intentionally empty — use index.css
        └── components/
            ├── Toolbar.jsx        # Browser nav bar (183 lines)
            ├── Sidebar.jsx        # AI chat sidebar (1052 lines) — main UI
            └── SettingsModal.jsx  # API key modal (130 lines)
```

---

## Module Systems — Critical Distinction

| Location | Module system | Syntax |
|---|---|---|
| `main.js`, `preload.js` | CommonJS | `require()` / `module.exports` |
| `renderer/src/**` | ES Module | `import` / `export` |

Never mix the two. Do not use `import`/`export` in `main.js` or `preload.js`.
Do not use `require()` in renderer source files.

---

## Package Versions

### Root `package.json` (key dependencies)

| Package | Version | Role |
|---|---|---|
| `electron` | `^40.6.1` | Desktop shell |
| `openai` | `^6.25.0` | OpenAI SDK (chat completions + tools) |
| `concurrently` | `^9.2.1` | Run renderer + electron in parallel |
| `cross-env` | `^10.1.0` | Set `NODE_ENV=development` cross-platform |
| `wait-on` | `^9.0.4` | Wait for Vite :5173 before launching Electron |
| `electron-builder` | `^26.8.1` | Package app for Mac/Win/Linux |

### Renderer `package.json` (key dependencies)

| Package | Version | Role |
|---|---|---|
| `react` | `^19.2.0` | UI framework |
| `react-dom` | `^19.2.0` | DOM renderer |
| `lucide-react` | `^0.576.0` | Icon library (42+ icons used) |
| `react-markdown` | `^10.1.0` | Render assistant messages as Markdown |
| `remark-gfm` | `^4.0.1` | GitHub Flavored Markdown (tables, strikethrough, etc.) |
| `vite` | `^7.3.1` | Dev server + build tool |
| `@vitejs/plugin-react` | `^5.1.1` | React fast refresh |
| `eslint` | `^9.39.1` | Linter |

---

## Code Style

### JavaScript / JSX

- **No TypeScript.** Plain `.js` and `.jsx` only. `@types/react` is in `devDependencies` for
  editor intellisense only — it does not affect the build.
- **No Prettier.** No `.prettierrc`, no `format` script. Do not introduce one without explicit
  instruction.
- Follow the ESLint config at `renderer/eslint.config.js`:
  - Extends `js.configs.recommended`, `reactHooks.configs.flat.recommended`,
    `reactRefresh.configs.vite`.
  - `no-unused-vars` is an **error**; vars matching `/^[A-Z_]/` are exempt (`varsIgnorePattern`).
  - `eslint-plugin-react-hooks` rules are enforced.
  - `eslint-plugin-react-refresh` (Vite preset) is enforced.
- Use **2-space indentation** (consistent with all existing files).
- **Single quotes** for strings throughout (both `main.js` and renderer).

### Imports (renderer)

Follow the existing pattern — no enforced rule but keep this order:

```js
import { useState, useEffect, useCallback } from 'react'  // 1. React
import ReactMarkdown from 'react-markdown'                 // 2. Third-party
import remarkGfm from 'remark-gfm'
import Sidebar from './components/Sidebar'                 // 3. Local components
import './index.css'                                       // 4. Local CSS
```

No explicit `.jsx` extension required for Vite local imports (resolved automatically).

### Naming Conventions

- **React components**: PascalCase (`Sidebar`, `SettingsModal`, `Toolbar`).
- **Files**: PascalCase for components (`Sidebar.jsx`), camelCase for scripts
  (`main.js`, `preload.js`, `vite.config.js`).
- **Variables / functions**: camelCase.
- **Constants / layout values**: SCREAMING_SNAKE_CASE (`SIDEBAR_WIDTH`, `TOOLBAR_HEIGHT`,
  `TOKEN_BUDGET`, `MAX_ITERATIONS`).
- **IPC channel names**: `domain:action` kebab format
  (e.g. `browser:navigate`, `agent:tool-call`, `chat:send`).
- **React event handlers**: prefix with `handle` (`handleNavigate`, `handleSaveApiKey`,
  `handleToggleSidebar`).

### React Patterns

- Wrap all event handlers in `useCallback`. Pass stable callbacks as props to avoid unnecessary
  re-renders.
- Use `useEffect` cleanup to call `api.removeAllListeners(channel)` for every IPC listener
  registered in that effect.
- Access the Electron API via `window.electronAPI` (aliased as `api` locally) with optional
  chaining (`api?.navigate(url)`) to allow the component to render safely in a plain browser
  context.
- Prefer **inline style objects** for component-level layout. Global tokens are CSS custom
  properties defined in `renderer/src/index.css`.
- Do not introduce CSS Modules or styled-components without explicit approval.

### CSS / Styling

All CSS custom properties live in `renderer/src/index.css` under `:root`:

```css
--bg-primary: #0f0f0f     /* main app background */
--bg-secondary: #1a1a1a   /* toolbar, sidebar */
--bg-tertiary: #242424    /* input fields, code blocks */
--bg-hover: #2a2a2a       /* hover states */
--border: #2e2e2e
--border-light: #3a3a3a
--text-primary: #e8e8e8
--text-secondary: #888
--text-muted: #555
--accent: #6366f1         /* indigo — interactive highlights */
--accent-hover: #7c7ff5
--accent-dim: rgba(99,102,241,0.15)
--success: #22c55e
--warning: #f59e0b
--error: #ef4444
--sidebar-width: 380px
--toolbar-height: 56px
```

- The app is **dark-mode only**. Do not add light-mode styles.
- Use `var(--border)` / `var(--border-light)` for borders; `var(--text-primary)` /
  `var(--text-secondary)` / `var(--text-muted)` for text; `var(--accent)` for interactive
  highlights. Never hard-code hex values.

### Error Handling

- Electron navigation helpers (`canGoBack`, `goBack`, etc.) use `try/catch (_) {}` to silently
  swallow errors — acceptable for version-compatibility shims.
- Agent tool execution uses `try/catch` and returns structured error objects rather than throwing,
  so the model can read the error and decide what to do next.
- In React components, prefer guarded access (`api?.method()`) over try/catch for optional
  Electron API calls.
- Never swallow errors silently in new logic that is not a compatibility shim. At minimum,
  `console.error` them.

### main.js Conventions

- Section headers use ASCII banner comments:
  ```js
  // ─── Section Name ─────────────────────────────────────────────────────────────
  ```
- `ipcMain.on` for fire-and-forget; `ipcMain.handle` for request/response (returns a Promise
  to the renderer).
- Real-time agent events are sent to the renderer via
  `mainWindow.webContents.send(channel, payload)`.

---

## Environment Variables

| Variable | Where used | Notes |
|---|---|---|
| `NODE_ENV` | `main.js` (isDev check) | Set to `development` by `dev:electron` script via `cross-env` |
| `OPENAI_KEY` | `.env` → auto-init at startup | If present, OpenAI client is initialized before any user interaction |

**`.env` parsing**: There is no `dotenv` package. A self-invoking IIFE at the top of `main.js`
parses `.env` manually using `fs.readFileSync`. It strips surrounding quotes from values and
does NOT overwrite existing `process.env` keys. If `.env` is absent the IIFE silently continues.

If `process.env.OPENAI_KEY` is set (whether from `.env` or the shell), an `OpenAI` client is
auto-initialized at startup — no need to enter the key via the UI in that case.

The `.env` file is gitignored. **Never commit it.** The runtime API key can also be set
in-memory via `ipcMain.on('set-api-key', ...)` through the Settings modal and is never written
to disk.

---

## Key Architectural Notes

### BrowserView

The browser viewport is a **BrowserView** (not a `<webview>` tag). Its pixel bounds are managed
by `updateBrowserViewBounds()` in `main.js` and must be kept in sync whenever the sidebar or
modal open/close state changes.

- Always call `api.setSidebar(open)` / `api.setModal(open)` from the renderer when those states
  change.
- When `modalOpen` is true, the BrowserView is collapsed to 1×1 px so the React modal can
  receive pointer events.
- `BrowserWindow` config: `1400×900`, min `900×600`, `titleBarStyle: 'hiddenInset'`,
  `trafficLightPosition: { x: 16, y: 16 }`, `backgroundColor: '#0f0f0f'`.
- `BrowserView` config: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`.

### Context Bridge

`preload.js` is the only bridge between renderer and main. All new capabilities exposed to the
renderer must be added to the `contextBridge` object there. The `electronAPI` surface in
`preload.js` and the corresponding `ipcMain` handlers in `main.js` must be kept in sync.

### Console Log Capture

On every `did-finish-load`, a JS snippet is injected into the BrowserView that wraps
`console.log/info/warn/error/debug` and buffers up to 200 entries in
`window.__nanobrowse_console_logs`. This is what the `get_console_logs` agent tool reads.

### New-Page Intercept

`browserView.webContents.setWindowOpenHandler` is set to load the new URL in the same
BrowserView instead of opening a new window (calls `loadURL` on the new URL then returns
`{ action: 'deny' }`).

---

## preload.js — `window.electronAPI` Surface

```js
// Browser navigation (fire-and-forget via ipcRenderer.send)
navigate(url)          // → 'browser:navigate'
goBack()               // → 'browser:go-back'
goForward()            // → 'browser:go-forward'
reload()               // → 'browser:reload'
stop()                 // → 'browser:stop'

// Browser queries (promise via ipcRenderer.invoke)
getUrl()               // → 'browser:get-url'
getTitle()             // → 'browser:get-title'

// Browser events (ipcRenderer.on listeners)
onLoading(cb)          // ← 'browser:loading'        cb(boolean)
onUrlChanged(cb)       // ← 'browser:url-changed'    cb(string)
onTitleChanged(cb)     // ← 'browser:title-changed'  cb(string)
onFaviconChanged(cb)   // ← 'browser:favicon-changed' cb(string url)
onNavState(cb)         // ← 'browser:nav-state'      cb({ canGoBack, canGoForward })

// API Key
setApiKey(key)         // → 'set-api-key'
getApiKey()            // → 'get-api-key'  (returns '••••••••' + last 4 chars or '')

// Chat / Agent
sendChat(payload)      // → 'chat:send'  (invoke — returns { response, toolResults } | { error })
stopAgent()            // → 'agent:stop'

// Agent real-time events
onToolCall(cb)         // ← 'agent:tool-call'    cb({ name, args })
onToolResult(cb)       // ← 'agent:tool-result'  cb({ name, args, result })
onProgress(cb)         // ← 'agent:progress'     cb({ message, step, total })
onScreenshot(cb)       // ← 'agent:screenshot'   cb({ dataUrl })
onThinking(cb)         // ← 'agent:thinking'     cb({ phase, content })
                       //     phase: 'think' | 'plan' | 'reflect' | 'status'

// Human-in-the-loop
onAskUser(cb)          // ← 'agent:ask-user'     cb({ id, question, options?, field_hints? })
sendUserAnswer(id, answer) // → 'agent:user-answer'

// Layout sync
setSidebar(open)       // → 'browser:set-sidebar'
setModal(open)         // → 'browser:set-modal'

// Cleanup
removeAllListeners(channel)
```

---

## main.js — Section-by-Section Breakdown

Sections are delimited by `// ─── Section Name ───` banners:

1. **Load .env** — manual IIFE parser; auto-init `openaiClient` if `OPENAI_KEY` present
2. **Global state** — `mainWindow`, `browserView`, `openaiClient`, `apiKey`,
   `agentAbortController`, `sidebarOpen`, `modalOpen`, `SIDEBAR_WIDTH=380`, `TOOLBAR_HEIGHT=56`
3. **Helpers** — `normalizeUrl`, `canGoBack`, `canGoForward`, `goBack`, `goForward`,
   `updateBrowserViewBounds`, `waitForPageLoad`, `getDOMSnapshot`, `askUser`
4. **Window** — `createWindow()`: BrowserWindow + BrowserView setup, event wiring for
   loading/url/title/favicon/nav-state, console log injection on `did-finish-load`,
   window-open intercept
5. **IPC: Layout** — `browser:set-sidebar`, `browser:set-modal`
6. **IPC: Browser Controls** — `browser:navigate`, `browser:go-back`, `browser:go-forward`,
   `browser:reload`, `browser:stop`, `browser:get-url` (handle), `browser:get-title` (handle)
7. **IPC: API Key** — `set-api-key`, `get-api-key` (handle)
8. **IPC: User answers agent questions** — `agent:user-answer`
9. **IPC: Stop agent** — `agent:stop`
10. **Tool definitions** — `TOOLS` array (24 tools, see below)
11. **Tool executor** — `executeTool(name, args, sendEvent)` — switch/case for all 24 tools
12. **Token-efficient compression utilities** — `compressSnapshot`, `compressToolResult`,
    `summarizeHistory`, `estimateTokens`
13. **System prompt** — `CORE_PROMPT`, `SITE_CONFIGS`, `sessionScratchpad`, `getDomain`,
    `getSiteHints`, `learnSiteHint`, `buildSystemPrompt`
14. **IPC: Chat — Think-Plan-Act-Reflect Agentic Loop** — `chat:send` (handle)
15. **App Lifecycle** — `app.whenReady`, `window-all-closed`, `activate`

### IPC Channels Summary

| Channel | Direction | Type | Handler |
|---|---|---|---|
| `browser:navigate` | renderer → main | `on` | load URL in BrowserView |
| `browser:go-back` | renderer → main | `on` | goBack |
| `browser:go-forward` | renderer → main | `on` | goForward |
| `browser:reload` | renderer → main | `on` | reload |
| `browser:stop` | renderer → main | `on` | stop loading |
| `browser:set-sidebar` | renderer → main | `on` | update bounds |
| `browser:set-modal` | renderer → main | `on` | update bounds |
| `set-api-key` | renderer → main | `on` | init OpenAI client |
| `agent:user-answer` | renderer → main | `on` | resolve pending Promise |
| `agent:stop` | renderer → main | `on` | abort controller + resolve questions |
| `browser:get-url` | renderer → main | `handle` | return current URL |
| `browser:get-title` | renderer → main | `handle` | return current title |
| `get-api-key` | renderer → main | `handle` | return masked key |
| `chat:send` | renderer → main | `handle` | run agentic loop |
| `browser:loading` | main → renderer | `send` | boolean |
| `browser:url-changed` | main → renderer | `send` | string |
| `browser:title-changed` | main → renderer | `send` | string |
| `browser:favicon-changed` | main → renderer | `send` | string (favicon URL) |
| `browser:nav-state` | main → renderer | `send` | `{ canGoBack, canGoForward }` |
| `agent:tool-call` | main → renderer | `send` | `{ name, args }` |
| `agent:tool-result` | main → renderer | `send` | `{ name, args, result }` |
| `agent:progress` | main → renderer | `send` | `{ message, step, total }` |
| `agent:screenshot` | main → renderer | `send` | `{ dataUrl }` |
| `agent:thinking` | main → renderer | `send` | `{ phase, content }` |
| `agent:ask-user` | main → renderer | `send` | `{ id, question, options?, field_hints? }` |

---

## Agentic Loop (`chat:send` handler)

### Configuration

| Parameter | Value |
|---|---|
| Model | `gpt-4o-mini` |
| Temperature | `0.2` |
| Max tokens per call | `4096` |
| Max iterations | `30` |
| `TOKEN_BUDGET` | `90000` chars (~90k tokens) |
| `SUMMARIZE_THRESHOLD` | `50000` chars — triggers history summarization |
| Abort mechanism | `AbortController` stored in `agentAbortController` |

### Think → Plan → Act → Reflect (TPAR) Loop

Each iteration:
1. Check abort signal and token budget (summarize if over threshold)
2. Call `openaiClient.chat.completions.create(...)` with `tool_choice: 'auto'`
3. If `message.content` is present alongside tool calls, extract strategy classification
   (`DIRECT` / `SEARCH` / `BROWSE` / `MULTI_STEP`) and emit `agent:thinking` with
   `phase: 'plan'` (iterations 1-2) or `phase: 'think'` (later)
4. Emit `agent:thinking` with `phase: 'status'` (step counter)
5. If tool calls present:
   - **Read-only tools** (`get_dom_snapshot`, `get_aria_snapshot`, `screenshot`,
     `get_console_logs`, `search_web`, `report_progress`) run via `Promise.all` when all
     tool calls in the batch are read-only
   - All other (mutating) tool calls run **sequentially**
   - After each tool result, `compressToolResult` is applied before adding to message history
   - If a `navigate` succeeds and there are more tool calls queued in the same batch, an
     auto-snapshot is appended to the navigate result (`autoSnapshot` field)
   - `trackToolResult` checks for repeated failures (same tool+selector ≥ 2×) or re-navigation
     loops and injects `[SYSTEM]` guidance messages after all tool responses
6. If no tool calls: model returned final text → break loop

### Failure Tracking

- `failureLog`: `[{ tool, selector, error, iteration, key }]` — threshold = 2 failures with
  same key within last 3 iterations → inject guidance
- `navigateLog`: `[{ url, iteration, success }]` — same URL navigated ≥ 2× → inject skip
  guidance; same domain failed ≥ 2× → inject domain-unreachable guidance
- Deferred guidance pattern: guidance messages are collected during tool execution and injected
  into `currentMessages` as `{ role: 'system', content: guidance }` **after** all tool response
  messages for a given turn have been added (preserves OpenAI message ordering rules)

### Token Management

- `estimateTokens(messages)`: rough estimate (chars / 4)
- If `estimatedTokens > TOKEN_BUDGET` and `messages.length <= 8`: bail with hard-cap message
- If `estimatedTokens > SUMMARIZE_THRESHOLD`: call `summarizeHistory(messages, 12)`
- If `estimatedTokens > TOKEN_BUDGET`: call `summarizeHistory(messages, 6)`
- `summarizeHistory`: keeps system message + last `floor(maxMessages * 0.7)` messages;
  compresses the middle into a single user/assistant pair summary

---

## Agent Tools (24 total)

| Tool | Type | Description |
|---|---|---|
| `navigate` | mutating | Load URL or Google search; 2-attempt retry with 15s timeout; classifies nav errors |
| `get_dom_snapshot` | read-only | Full DOM snapshot: URL, title, pageText (12k chars), interactive elements (≤150), inputFields, calendarInfo |
| `click` | mutating | Click by CSS selector; 4-strategy fallback (selector → text-match → label-for → partial); full mouse event sequence for SPAs |
| `type_text` | mutating | Keystroke-based typing; 5-strategy focus fallback; detects datepicker inputs and uses setter-only path |
| `fill` | mutating | Set input value directly via native setter + dispatch input/change events |
| `press_key` | mutating | Send keystroke; special Enter handling: dispatch KeyboardEvent + form submit |
| `select_option` | mutating | Set `<select>` value by option value or text (case-insensitive contains) |
| `scroll` | mutating | Scroll page or element; directions: up/down/top/bottom |
| `wait` | mutating | Wait ms (max 5000) or wait for page load |
| `screenshot` | read-only | Capture BrowserView; sends `agent:screenshot` event; returns metadata only (not base64 to model) |
| `ask_user` | mutating | Pause loop; sends `agent:ask-user`; resolves when renderer sends `agent:user-answer`; supports `options` (quick-reply buttons) and `field_hints` (structured multi-field with `sensitive` flag) |
| `report_progress` | read-only | Send `agent:progress` event; no side effects |
| `hover` | mutating | Dispatch mouseover/mouseenter events |
| `go_back` | mutating | Navigate back in BrowserView history |
| `go_forward` | mutating | Navigate forward in BrowserView history |
| `wait_for_selector` | mutating | Poll for CSS selector or URL pattern; on timeout returns diagnostic snapshot |
| `dismiss_overlay` | mutating | Auto-detect and dismiss cookie/location/login/notification overlays; hint-aware priority; Escape fallback |
| `search_web` | read-only | Load Google search URL in BrowserView, scrape results (≤12), return title/url/snippet; navigates BrowserView |
| `get_console_logs` | read-only | Read `window.__nanobrowse_console_logs` buffer from BrowserView |
| `get_aria_snapshot` | read-only | Build ARIA accessibility tree as YAML (depth ≤8); filters non-meaningful nodes |
| `drag` | mutating | Full drag event sequence (dragstart → dragover steps → dragenter → drop → dragend) |
| `learn_site_hint` | mutating | Store per-domain hint in `sessionScratchpad` Map (domain → hint string); injected into future prompts |
| `probe_form` | read-only | Analyze form fields; returns `{ selector, labelText, fieldType, strategy, currentValue }` for each; classifies as text-input / select / native-date-input / custom-date-picker / autocomplete-widget / contenteditable / custom-widget |
| `select_date` | mutating | Calendar date picker interaction; strategies: data-date attr → aria-label → data-value/data-day; auto-navigates months (max 14 navigations); requires `date: YYYY-MM-DD` |

### getDOMSnapshot details

Returns: `{ url, title, pageText (≤12000 chars), interactive (≤150 elements), inputFields, calendarInfo?, scrollY, pageHeight, viewportHeight }`

Each interactive element: `{ tag, type, selector, text, href, value, checked, disabled, dataDate, dataTestid }`

`calendarInfo` is included when `[data-date]` cells > 5 are detected (open calendar picker).

Health check: if `document.body` is missing or `innerHTML.length < 20`, reloads the page once before returning.

Selector priority: `#id` → `[data-testid]` → `tag[name]` → `tag[placeholder]` → `[aria-label]` → `[role]` → `tag[type]` → `tag.class1.class2`

Deduplication: repeated selectors get `:eq(N)` suffix.

### compressSnapshot

Applied to `get_dom_snapshot` results before adding to message history:
- Truncates `pageText` to 4000 chars (from 12000)
- Limits interactive elements to 50 (scored by relevance to task hint)
- Strips `rect` from elements
- Limits `inputFields` to 8

---

## System Prompt Architecture (Three Layers)

Built by `buildSystemPrompt(pageContext, taskHint)`:

1. **Layer 1 — `CORE_PROMPT`** (static, ~80 lines): TPAR loop instructions, strategy
   classification, all 24 tool names, efficiency rules, single-tab constraint, form filling
   rules, recovery escalation ladder, network failure handling, output format.

2. **Layer 2 — `SITE_CONFIGS`** (dynamic, injected only for matching domain): 14 pre-configured
   sites with compact per-site hints:

   | Site | Match pattern |
   |---|---|
   | Amazon | `/amazon\./` |
   | Flipkart | `/flipkart\.com/` |
   | Croma | `/croma\.com/` |
   | Blinkit | `/blinkit\.com/` |
   | Swiggy | `/swiggy\.com/` |
   | Zomato | `/zomato\.com/` |
   | Zepto | `/zepto\.com/` |
   | Reddit | `/reddit\.com/` |
   | LinkedIn | `/linkedin\.com/` |
   | MakeMyTrip | `/makemytrip\.com/` |
   | Booking.com | `/booking\.com/` |
   | GitHub | `/github\.com/` |
   | YouTube | `/youtube\.com/` |
   | Google Search | `/google\.com\/search/` |

   `sessionScratchpad` learned hints (per-domain, accumulated during session via
   `learn_site_hint` tool) are appended after the matching SITE_CONFIGS entry.

3. **Layer 3 — Page context** (dynamic, only when `includePageContext: true`): URL + title +
   first 1500 chars of `pageText` from a compressed DOM snapshot taken at the start of each
   `chat:send` call.

   Today's date is also injected (`## TODAY\n<weekday, day month year in en-GB format>`).

---

## Renderer Components

### `App.jsx` (128 lines)

Root component. State: `displayUrl`, `title`, `_favicon` (underscore prefix suppresses
`no-unused-vars` lint — the value is set but not rendered), `loading`, `canGoBack`,
`canGoForward`, `sidebarOpen`, `showSettings`, `apiKey`.

Registers IPC listeners (`onLoading`, `onUrlChanged`, `onTitleChanged`, `onFaviconChanged`,
`onNavState`) in a single `useEffect` with cleanup. Syncs `sidebarOpen` and `showSettings`
to main process via separate effects.

Renders: `<Toolbar>` + browser placeholder `<div>` + conditional `<Sidebar>` + conditional
`<SettingsModal>`.

Props passed to `Toolbar`: `url`, `loading`, `canGoBack`, `canGoForward`, `sidebarOpen`,
`onNavigate`, `onBack`, `onForward`, `onReload`, `onToggleSidebar`, `onOpenSettings`.

Props passed to `Sidebar`: `currentTitle`, `hasApiKey`, `onOpenSettings`.

Props passed to `SettingsModal`: `onSave`, `onClose`, `currentKey`.

### `Toolbar.jsx` (183 lines)

Browser navigation bar. State: `editVal`, `focused`, `hoveredBtn`. Ref: `inputRef`.

Icons (lucide-react): `ArrowLeft`, `ArrowRight`, `RotateCw` (reload) / `X` (stop), `Home`,
`Shield` / `ShieldOff` (HTTPS indicator), `SidebarClose` / `SidebarOpen`, `Settings`.

Layout: macOS traffic light spacer (70px) → nav buttons → URL bar form → sidebar toggle →
settings button.

URL bar behavior: shows live URL when blurred; shows editable value when focused; selects all
on focus.

All buttons rendered via `iconBtn(id, icon, onClick, disabled, title)` helper — handles hover
state inline.

`WebkitAppRegion: 'drag'` on toolbar div; `WebkitAppRegion: 'no-drag'` on all interactive
children.

### `Sidebar.jsx` (1052 lines)

Main AI chat UI. Sub-components defined in the same file:

| Sub-component | Purpose |
|---|---|
| `ToolCallBadge` | Shows a single tool call with icon, label, success/fail indicator; expandable result pane (JSON, max 800 chars) |
| `ProgressBar` | Shows `report_progress` events with optional step/total bar |
| `AskUserCard` | Human-in-the-loop pause card; supports free-text, quick-reply buttons, and structured multi-field mode (with `sensitive` → password inputs) |
| `ScreenshotPreview` | Collapsible screenshot thumbnail |
| `ThinkingBubble` | Single thinking/planning/reflecting text bubble with phase-aware color |
| `ThinkingIndicator` | Live indicator shown while agent is running: step counter + scratchpad toggle + `ThinkingBubble` + animated dots |
| `ScratchpadSummary` | Collapsed list of all agent reasoning steps from the completed turn |
| `Message` | Full message renderer: progress bars + screenshots + tool call badges + scratchpad summary + ask-user card + text bubble + timestamp |

`TOOL_META` constant maps each of the 24 tool names to `{ icon, color, label(args) }` for
display in `ToolCallBadge`.

`QUICK_ACTIONS` constant: 4 quick-action buttons shown only on the first (empty) chat state:
"Summarize this page", "Find all links on this page", "Take a screenshot", "Search for AI news".

Sidebar state:
- `messages` — array of message objects; `role: 'user'|'assistant'`; assistant messages carry
  `toolCalls`, `progressEvents`, `screenshots`, `scratchpad`, `askUser`, `error` optional fields
- `input` — textarea value
- `loading` — boolean (agent running)
- `currentTool` — label of tool currently executing (shown in `ThinkingIndicator`)
- `thinkingContent` — `{ phase, content }` from last `agent:thinking` event
- `scratchpad` / `scratchpadRef` — array of `{ phase, content, time }` entries (max 10)
- `agentStep` — string like "Step 3/30"
- `includeContext` — boolean; controls `includePageContext` sent to `chat:send`

Live refs (not React state, to avoid re-renders during agent run):
- `liveToolsRef` — tool calls accumulating for current turn
- `liveProgressRef` — progress events for current turn
- `liveScreenshotsRef` — screenshots for current turn

IPC listeners registered in one `useEffect` with cleanup:
`agent:tool-call`, `agent:tool-result`, `agent:progress`, `agent:screenshot`,
`agent:thinking`, `agent:ask-user`.

`sendMessage(text?)`: builds history (filters to user+assistant messages with non-null content),
calls `api.sendChat({ messages: history, includePageContext: includeContext })`, then commits
all captured live refs into the final assistant message.

Context toggle button (bottom bar): "Page context: ON/OFF" — toggles `includeContext`.

Markdown rendering (assistant bubbles only): `<ReactMarkdown remarkPlugins={[remarkGfm]}>`;
all `.markdown-body` styles injected via inline `<style>` block (supports p, ul/ol, code,
pre, h1-h3, a, blockquote, hr, table).

### `SettingsModal.jsx` (130 lines)

Full-screen modal overlay for entering the OpenAI API key. State: `key`, `error`.

Validates that key is non-empty and starts with `sk-`. On save calls `onSave(key.trim())`.
Shows current masked key if already set. Auto-focuses the password input on open.

---

## Vite Config (`renderer/vite.config.js`)

```js
base: './'          // relative assets path — required for Electron file:// loading
server.port: 5173
server.strictPort: true
build.outDir: 'dist'
build.emptyOutDir: true
plugins: [react()]  // @vitejs/plugin-react (Babel-based fast refresh)
```

## ESLint Config (`renderer/eslint.config.js`)

ESLint 9 flat config. Key rules:

```js
files: ['**/*.{js,jsx}']
extends: [js.configs.recommended, reactHooks.configs.flat.recommended, reactRefresh.configs.vite]
languageOptions: { ecmaVersion: 2020, globals: globals.browser }
rules: { 'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }] }
```

`dist/` is globally ignored via `globalIgnores`.

---

## electron-builder Config (in root `package.json`)

```json
"build": {
  "appId": "com.nanobrowse.app",
  "productName": "NanoBrowse",
  "directories": { "output": "dist" },
  "files": ["main.js", "preload.js", "renderer/dist/**", "node_modules/**", "assets/**"],
  "mac":   { "category": "public.app-category.productivity", "icon": "assets/icon.icns", "target": "dmg" },
  "win":   { "icon": "assets/icon.ico", "target": "nsis" },
  "linux": { "target": "AppImage" }
}
```
