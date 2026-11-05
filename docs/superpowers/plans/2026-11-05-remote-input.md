# Remote Input and Quiet Kiosk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live preview a remote control for the Pi's page (click, wheel, keyboard, paste) and stop Chromium's own prompts on the kiosk.

**Architecture:** The panel sends `{type:'input',…}` messages on the existing `/live` WebSocket. A new `src/input.js` validates them, maps normalized coordinates to the Pi's layout viewport and dispatches CDP `Input.*` commands; the preview temporarily raises its frame cap. A managed Chromium policy file silences browser bubbles.

**Tech Stack:** Node.js ≥ 20, `ws`, CDP `Input` domain, plain JS panel, Playwright for tests, bash.

**Spec:** `docs/superpowers/specs/2026-11-05-remote-input-design.md`

## Global Constraints

- No new runtime dependencies.
- Code, comments, commits in English; UI copy German (`TASTATUR → PI`).
- Coordinates on the wire are normalized 0–1; anything outside is dropped.
- Text messages max 2000 characters; wheel deltas clamped to ±2000.
- Special keys exactly: `Enter`, `Backspace`, `Delete`, `Tab`, `Escape`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`.
- Boost: up to 5 fps for 10 s after the last input, otherwise 2 fps.
- Input only via `/live` (Host/Origin checks already enforced).

## Review Focus

1. **Click before the layout viewport is known** (first input right after connect) – must still land correctly, not at 0,0. → Task 1 test.
2. **Letterboxed preview** (screen aspect differs from the panel's frame box) – clicks on the bars are ignored, clicks on the image map to the image, not the box. → Task 3 test.
3. **Typing while the preview is focused must not trigger panel shortcuts** (`b` must not black the screen). → Task 3 test.
4. **Malformed input messages** (missing fields, NaN, huge text) – dropped without throwing or crashing the socket. → Task 1 and Task 2 tests.
5. **Chromium disconnected while input arrives** – dropped quietly, no unhandled rejection. → Task 1 test.

---

### Task 1: Input dispatcher

**Files:**
- Create: `src/input.js`, `test/input.test.js`

**Interfaces:**
- Consumes: `Cdp` (`send`, `connected`, event `'connected'`).
- Produces:
  - `KEYS: Record<string, { code: string, keyCode: number }>` for the 13 special keys (Enter 13, Backspace 8, Delete 46, Tab 9, Escape 27, ArrowLeft 37, ArrowUp 38, ArrowRight 39, ArrowDown 40, Home 36, End 35, PageUp 33, PageDown 34).
  - `validateInput(msg): object | null` – returns a cleaned `{kind, …}` or `null`.
  - `createInput({ cdp }): { handle(msg): Promise<boolean> }` – `true` when dispatched, `false` when dropped. Viewport size cached from `Page.getLayoutMetrics` (`cssLayoutViewport.clientWidth/clientHeight`), cleared on `cdp 'connected'`, fetched lazily when missing.

- [ ] **Step 1: Failing tests** (`test/input.test.js`, real headless Chromium 1280×720 via `launchChromium`, local http page with a 200×100 button at `left:600px; top:300px` that sets `window.clicked = true`, a `<input id=t>` inside a `<form>` whose submit sets `window.submitted = true` and calls `preventDefault`, and a 4000px tall body):
  - `validateInput({type:'input',kind:'click',x:1.2,y:0.5})` → `null`; `kind:'text'` with 2001 chars → `null`; `kind:'key', key:'F5'` → `null`; `kind:'click', x:'a'` → `null`; valid click → `{kind:'click', x, y}`.
  - click at `(700/1280, 350/720)` immediately after connect (no prior metrics call) → `window.clicked === true` (**Review Focus 1**).
  - with `document.documentElement.style.zoom = '2'` and the button moved to `left:300px; top:150px` (CSS px) → click at `(700/1280, 350/720)` still sets `clicked`.
  - wheel `dy: 600` at centre → `scrollY > 0`.
  - focus `#t`, `text: 'hallo'` → `t.value === 'hallo'`; `key: 'Backspace'` → `'hall'`; `key: 'Enter'` → `window.submitted === true`.
  - **Review Focus 5:** `handle` while `cdp.connected === false` (fresh `Cdp` on an unused port) resolves `false` without throwing.
- [ ] **Step 2:** `node --test test/input.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement `src/input.js`.** Click = `mouseMoved`, `mousePressed`, `mouseReleased` (`button:'left'`, `clickCount:1`, `buttons` 1 on press). Wheel = `mouseWheel` with `deltaX/deltaY`. Text = `Input.insertText`. Key = `rawKeyDown` + `keyUp` with `key`, `code`, `windowsVirtualKeyCode`, `nativeVirtualKeyCode`; Enter additionally `char` with `text: '\r'` between them. Any CDP error → `false`.
- [ ] **Step 4:** run → PASS. **Step 5:** commit `feat: dispatch remote input to the kiosk page`.

### Task 2: Preview boost and server wiring

**Files:**
- Modify: `src/preview.js`, `src/server.js`, `bin/pi-anzeige.js`
- Test: `test/preview.test.js`, `test/server.test.js`

**Interfaces:**
- Consumes: `createInput` (Task 1).
- Produces:
  - `preview.boost(ms = 10000): void` – frame interval becomes `1000 / boostFps` (`boostFps = 5` option) until `ms` after the last call.
  - `createServer({ …, input })` – on WS `{type:'input'}` calls `await input.handle(msg)`; when it returns `true`, calls `preview.boost()`. Missing `input` option → messages ignored.
- [ ] **Step 1: Failing tests:**
  - preview (fake cdp, `maxFps: 2`, `boostFps: 5`): after `boost(1000)`, two frames 250 ms apart are both delivered immediately (no trailing wait); after the boost window, frames 250 ms apart are throttled again.
  - server (fake input recording messages, returning `true`): WS `{type:'input',kind:'click',x:0.5,y:0.5}` → `input.handle` called with it and `preview.boost` called once; `{type:'input'}` with `handle` returning `false` → no boost; a message `input.handle` throws on → socket stays open (**Review Focus 4**).
- [ ] **Step 2:** FAIL. **Step 3:** Implement; wire `createInput({ cdp })` in `bin/pi-anzeige.js`. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: forward panel input over the live socket and boost the preview`.

### Task 3: Clickable, focusable preview in the panel

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/app.css`
- Test: `test/ui.test.js`

**Interfaces:**
- Consumes: WS input protocol (spec §2).
- Behaviour:
  - `#frame` gets `tabindex="0"`, `aria-label="Live-Bild – klicken zum Bedienen"`; when focused: yellow 2px outline and a `#frameHint` label `TASTATUR → PI` (hidden otherwise).
  - Image rect = the area the `object-fit: contain` image actually covers (computed from the frame box and the image's natural aspect); clicks outside are ignored; `x = (clientX - rect.left) / rect.width`.
  - `click` → `{kind:'click'}`; `wheel` (non-passive, `preventDefault`) → `{kind:'wheel', dx, dy}` with `deltaMode` 1 multiplied by 40; `keydown` while focused → printable single-char key without Ctrl/Meta/Alt → `{kind:'text', text: e.key}`, special key from the list → `{kind:'key'}`, both `preventDefault`; `paste` → `{kind:'text', text}` (first 2000 chars).
  - Global shortcut handler returns early when `#frame` is focused.
- [ ] **Step 1: Failing Playwright tests** (server with recording fake `input`):
  - clicking the frame at 25 %/75 % of the displayed image sends `{kind:'click'}` with `x≈0.25, y≈0.75` (±0.02).
  - **Review Focus 2:** with `display.screen` 1080×1920 (portrait) in a landscape frame, a click on the left letterbox bar sends nothing.
  - **Review Focus 3:** after clicking the frame, typing `b1` sends two text messages and `PUT /api/black` is never called; `Enter` sends `{kind:'key', key:'Enter'}`; `#frameHint` is visible.
  - clicking outside the frame then pressing `b` toggles black as before.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; run `impeccable detect --json public/` → `[]`.
- [ ] **Step 5:** commit `feat: operate the kiosk page from the live preview`.

### Task 4: Quiet kiosk

**Files:**
- Create: `deploy/chromium-policy.json`, `test/deploy.test.js`
- Modify: `deploy/install.sh`, `deploy/chromium-kiosk.sh`, `README.md`

- [ ] **Step 1: Failing test** `test/deploy.test.js`: the policy file parses and deep-equals the spec §2 policy set; `deploy/chromium-kiosk.sh` contains `--lang=de`; `deploy/install.sh` contains `/etc/chromium/policies/managed/pi-anzeige.json`.
- [ ] **Step 2:** FAIL. **Step 3:** Add the file; `install.sh`: `install -d /etc/chromium/policies/managed` and `install -m 0644` the file (also to `/etc/chromium-browser/policies/managed/` when that directory's parent exists); add `--lang=de` to the kiosk script; README: one line under "How it works" on remote input and one on the policy file. **Step 4:** PASS; `shellcheck deploy/*.sh` clean.
- [ ] **Step 5:** commit `chore: silence chromium prompts on the kiosk`.

## Final

- [ ] Full suite green, whole-branch review by a fresh reviewer, push `feat/remote-input`.
