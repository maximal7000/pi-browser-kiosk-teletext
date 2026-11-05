# Pi-Anzeige Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js service on a Raspberry Pi 3B that drives a Chromium kiosk over the DevTools protocol (URL, zoom, black overlay, on-demand live preview) plus a teletext-styled German control panel.

**Architecture:** `cage` runs Chromium full-screen with remote debugging on 127.0.0.1:9222. One Node process holds the persisted state, keeps Chromium in that state through a small CDP client, streams screencast frames only while a panel is watching, and serves REST + WebSocket + static files on port 80.

**Tech Stack:** Node.js ≥ 20 (ES modules, `node:test`), `ws` 8.x, plain HTML/CSS/JS, Bedstead font, Playwright 1.63.0 (dev only), systemd, bash.

**Spec:** `docs/superpowers/specs/2026-11-05-pi-anzeige-design.md`

## Global Constraints

- Runtime dependency: `ws` only. No build step, no frontend framework.
- `"type": "module"`, `"engines": { "node": ">=20" }`.
- Code, comments, docs, commit messages in English (Conventional Commits). All user-facing UI text and API error messages in German.
- Only `http:` and `https:` URLs may be displayed.
- Zoom is stored and sent as a factor: 0.25–3.0, rounded to 0.05. UI shows percent.
- Page numbers 101–199, unique, auto-assigned as `max + 1` (or 101).
- Data file path: env `PI_ANZEIGE_DATA`, default `/var/lib/pi-anzeige/config.json`. HTTP port: env `PORT`, default 80. CDP: env `CDP_HOST` default `127.0.0.1`, `CDP_PORT` default `9222`.
- Preview: JPEG quality 60, max width 960, ≤ 2 frames/s per panel, screencast stopped when no panel watches.
- CDP reconnect backoff 1 s doubling to max 10 s. Page-load retry after 30 s, 60 s, then every 300 s.
- Tests that need a browser read `CHROMIUM_PATH`, else fall back to `require('playwright').chromium.executablePath()`.

## Review Focus

1. **Chromium not running at server start** (Pi boots Node before cage is up) – server must start, serve the panel, report `connected:false`, and apply state once Chromium appears. → test in Task 3.
2. **Page navigation while black is on** – overlay must reappear on the new document. → test in Task 3.
3. **Panel closes without a clean WS close** (laptop lid shut) – viewer must be removed on socket `close`/`error` and ping timeout, so the screencast stops. → test in Task 5.
4. **Deleting the page that is currently shown** – current display keeps showing that URL, `current.pageId` becomes `null`. → test in Task 1.
5. **Concurrent writes** (two tabs saving at once) – saves are serialized, file never truncated/corrupt. → test in Task 1.

---

## File Structure

```
package.json
src/
  state.js        persisted state store + validation
  cdp.js          minimal CDP client with reconnect
  display.js      drives Chromium to desired state; zoom maths; black overlay
  preview.js      viewer counting, screencast lifecycle, frame throttling
  server.js       HTTP routes, static files, WS /live
bin/pi-anzeige.js entry point (env → wiring)
public/
  index.html  app.css  app.js     control panel
  start.html                      kiosk start page (shown when nothing is set)
  fonts/bedstead.otf  fonts/LICENSE-bedstead.txt
deploy/
  install.sh  kiosk.service  pi-anzeige.service  chromium-kiosk.sh
test/
  helpers/chromium.js             launch headless Chromium with a debug port
  state.test.js  cdp.test.js  display.test.js  preview.test.js  server.test.js  ui.test.js
.github/workflows/ci.yml
README.md
```

---

### Task 1: Project scaffold + state store

**Files:**
- Create: `package.json`, `.gitignore`, `src/state.js`, `test/state.test.js`

**Interfaces:**
- Produces:
  - `class ValidationError extends Error { status = 400 }`
  - `validateUrl(input: string): string` – trims, returns `new URL(x).href`; throws `ValidationError('Bitte eine Adresse mit http:// oder https:// eingeben.')`
  - `normalizeZoom(z: number): number` – rounds to 0.05; throws `ValidationError('Zoom muss zwischen 25 % und 300 % liegen.')` outside 0.25–3
  - `async createStore({ file: string }): Store` where `Store` is an `EventEmitter` with:
    - `get(): State` (deep copy) – `State = { current: { url: string|null, zoom: number, pageId: string|null }, black: boolean, pages: Page[] }`, `Page = { id, number, name, url, zoom }`
    - `async show({ url?, zoom?, pageId? }): State` – `pageId` copies that page's url+zoom; unknown id → `ValidationError('Seite nicht gefunden.')` with `status = 404`
    - `async setZoom(z): State`, `async setBlack(b: boolean): State`
    - `async addPage({ name, url, zoom?, number? }): Page`, `async updatePage(id, patch): Page`, `async removePage(id): void`
    - emits `'change'` with the new `State` after every successful write

- [ ] **Step 1:** `package.json` (`name: "pi-anzeige"`, `private`, `type: module`, engines, scripts `"start": "node bin/pi-anzeige.js"`, `"test": "node --test test/"`, dependency `ws@^8.18.0`, devDependency `playwright@1.63.0`). `.gitignore`: `node_modules/`, `data/`. Run `npm install --ignore-scripts` (does not download browsers).
- [ ] **Step 2: Write failing tests** in `test/state.test.js` (each test uses a fresh temp dir):
  - missing file → `get()` equals `{ current: { url: null, zoom: 1, pageId: null }, black: false, pages: [] }`
  - `validateUrl('ftp://x')`, `validateUrl('javascript:alert(1)')`, `validateUrl('')` throw `ValidationError`; `validateUrl(' https://a.de ')` → `'https://a.de/'`
  - `normalizeZoom(1.12)` → `1.1`; `normalizeZoom(0.2)` and `normalizeZoom(3.05)` throw
  - `addPage` assigns 101, then 102; after removing 101, next is 103; name trimmed, empty name → `ValidationError('Bitte einen Namen eingeben.')`; duplicate `number` → `ValidationError('Seitennummer ist schon vergeben.')`
  - `show({ pageId })` sets url + zoom from the page; `show({ url })` sets `pageId: null`, zoom 1 unless given
  - **Review Focus 4:** remove the shown page → `current.url` unchanged, `current.pageId === null`
  - state survives a new `createStore` on the same file
  - corrupt file (`'{nope'`) → empty state, a sibling file matching `/config\.json\.broken-\d+/` exists
  - **Review Focus 5:** `await Promise.all([addPage(a), addPage(b), setBlack(true)])` → file parses, two pages with distinct numbers, `black: true`
  - `'change'` fires once per write with the new state
- [ ] **Step 3:** Run `node --test test/state.test.js` → FAIL (module missing).
- [ ] **Step 4: Implement `src/state.js`.** Writes go through one promise chain (serialization); each write = `writeFile(tmp)` + `rename(tmp, file)`; create the directory if missing. Ids via `crypto.randomUUID().slice(0, 8)`.
- [ ] **Step 5:** Run → PASS. Commit `feat: add persisted state store with validation`.

### Task 2: CDP client

**Files:**
- Create: `src/cdp.js`, `test/helpers/chromium.js`, `test/cdp.test.js`

**Interfaces:**
- Produces:
  - `class Cdp extends EventEmitter` – `constructor({ host = '127.0.0.1', port = 9222, minBackoff = 1000, maxBackoff = 10000 })`
  - `start(): void` (connect loop, never throws), `stop(): Promise<void>`
  - `connected: boolean`
  - `async send(method: string, params = {}): any` – rejects with `Error('not connected')` when disconnected, rejects with the CDP error message on protocol errors
  - events: `'connected'`, `'disconnected'`, and every CDP event re-emitted under its method name (e.g. `'Page.screencastFrame'`, params as argument)
  - Target choice: `GET /json/list` → first `type === 'page'`; none → `PUT /json/new?about:blank`
- `test/helpers/chromium.js`: `async launchChromium({ headless = true, width = 1280, height = 720 }): { port, kill(): Promise<void>, restart(): Promise<void> }` – spawns with `--remote-debugging-port=0 --user-data-dir=<tmp> --window-size=W,H --no-first-run --no-sandbox`, reads the port from `<user-data-dir>/DevToolsActivePort`; `restart()` relaunches on the **same** port.

- [ ] **Step 1: Failing tests:** connects and `send('Runtime.evaluate', { expression: '1+1', returnByValue: true })` → `result.value === 2`; `send` while disconnected rejects; `'Page.loadEventFired'` is re-emitted after `Page.enable` + `Page.navigate` to a `data:` URL; after `chromium.restart()` the client emits `'disconnected'` then `'connected'` again within 15 s; `start()` against a port with nothing listening keeps `connected === false` without throwing, then connects once Chromium is launched on that port.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** with `ws` as the WebSocket client and `fetch` for `/json/*`. Message ids increment; pending map rejects all on close.
- [ ] **Step 4:** Run → PASS. Commit `feat: add CDP client with reconnect`.

### Task 3: Display controller

**Files:**
- Create: `src/display.js`, `test/display.test.js`

**Interfaces:**
- Consumes: `Store` (Task 1), `Cdp` (Task 2)
- Produces:
  - `zoomMetrics({ width, height }, zoom): { width: number, height: number, deviceScaleFactor: number, mobile: false }` – `width: Math.round(width / zoom)`, `height: Math.round(height / zoom)`, `deviceScaleFactor: zoom`
  - `createDisplay({ cdp, store, startUrl, retryDelays = [30000, 60000, 300000] }): Display` (EventEmitter)
    - `status(): { connected: boolean, loading: boolean, error: string|null, screen: { width, height } | null }`
    - `async apply(): void` – navigates to `current.url ?? startUrl`, applies zoom, applies black
    - `async reload(): void`
    - emits `'status'` on every status change
  - Listens itself: `store 'change'` → apply only what changed (url/zoom/black); `cdp 'connected'` → read screen via `Browser.getWindowForTarget` bounds, `Page.enable`, full `apply()`.
  - Black: when on, `Page.addScriptToEvaluateOnNewDocument` (keep identifier) + `Runtime.evaluate` of the same script; when off, `Page.removeScriptToEvaluateOnNewDocument` + evaluate removal. Overlay = `div` with id `__pi_anzeige_black`, closed shadow root, `position:fixed; inset:0; background:#000; z-index:2147483647`, appended to `document.documentElement`.
  - Load failure = `Page.navigate` returns `errorText`: status `error: 'Seite nicht erreichbar'`, retry per `retryDelays` (last value repeats); a new navigation cancels pending retries.

- [ ] **Step 1: Failing tests:**
  - `zoomMetrics({ width: 1920, height: 1080 }, 1.5)` → `{ width: 1280, height: 720, deviceScaleFactor: 1.5, mobile: false }`
  - with real Chromium + temp store: `store.show({ url: <data URL with white body> })` → `Runtime.evaluate('location.href')` matches
  - zoom 2 → `window.innerWidth` evaluates to half the window width (±1)
  - black on → `Page.captureScreenshot` decoded centre pixel is black (read JPEG/PNG via `Page.captureScreenshot({ format: 'png' })` and check bytes with a tiny PNG decode using `zlib.inflateSync`, helper in the test file)
  - **Review Focus 2:** black on, then navigate to another data URL → overlay element exists on the new document
  - black off → overlay element absent
  - **Review Focus 1:** create display with Chromium not yet running, set a URL in the store, then launch Chromium on that port → within 15 s the URL is shown and `status().connected === true`
  - unreachable URL (`http://127.0.0.1:9/`) with `retryDelays: [200]` → `status().error === 'Seite nicht erreichbar'`, a second navigate attempt observed
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: add display controller for url, zoom and black overlay`.

### Task 4: Preview streamer

**Files:**
- Create: `src/preview.js`, `test/preview.test.js`

**Interfaces:**
- Consumes: `Cdp` (Task 2) – only `send`, `connected`, events `'connected'`, `'Page.screencastFrame'`
- Produces:
  - `createPreview({ cdp, maxFps = 2, maxWidth = 960, quality = 60 }): Preview`
    - `addViewer(id: string, send: (jpeg: Buffer) => void): void` – sends `lastFrame` immediately if present
    - `removeViewer(id: string): void`
    - `viewerCount(): number`
    - `lastFrameAt: number | null` (ms epoch)
  - 0→1 viewers: `Page.startScreencast({ format: 'jpeg', quality, maxWidth, everyNthFrame: 1 })`; 1→0: `Page.stopScreencast`. On `cdp 'connected'` with viewers > 0: start again.
  - Every `Page.screencastFrame` is acked (`Page.screencastFrameAck({ sessionId })`) immediately. Forwarding is throttled to one frame per `1000 / maxFps` ms; the newest frame inside a window is sent at the window's end (trailing), older ones dropped.

- [ ] **Step 1: Failing tests** with a fake cdp (EventEmitter + recorded `send` calls):
  - first `addViewer` → one `Page.startScreencast` with `{ format: 'jpeg', quality: 60, maxWidth: 960 }`; second viewer → no second start; removing both → exactly one `Page.stopScreencast`
  - each emitted frame is acked once with its `sessionId`
  - 10 frames emitted within 100 ms with `maxFps: 2` → viewer receives 1 immediately and 1 trailing (the 10th) after ~500 ms, total 2
  - late viewer receives last frame immediately
  - fake `'connected'` with 1 viewer → `Page.startScreencast` sent again
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** One integration test with real Chromium: viewer added → at least one JPEG (`buffer[0] === 0xff && buffer[1] === 0xd8`) within 5 s. Commit `feat: add on-demand preview streamer`.

### Task 5: HTTP + WebSocket server and entry point

**Files:**
- Create: `src/server.js`, `bin/pi-anzeige.js`, `test/server.test.js`

**Interfaces:**
- Consumes: `Store`, `Display`, `Preview`, `ValidationError`
- Produces:
  - `createServer({ store, display, preview, publicDir, pingInterval = 15000 }): http.Server`
  - Routes (JSON in/out, body limit 16 KB, `Content-Type: application/json` required for bodies):
    - `GET /api/state` → `{ state, display: display.status() }`
    - `PUT /api/current` body `{ url, zoom? }` or `{ pageId }` → `{ state }`
    - `PUT /api/zoom` `{ zoom }`, `PUT /api/black` `{ black }` → `{ state }`
    - `POST /api/reload` → `204`
    - `GET /api/pages`, `POST /api/pages` → `201 { page }`, `PUT /api/pages/:id` → `{ page }`, `DELETE /api/pages/:id` → `204`
    - errors: `ValidationError` → its `status` + `{ error }`; malformed JSON → 400 `{ error: 'Ungültige Anfrage.' }`; unknown route → 404 `{ error: 'Nicht gefunden.' }`; other → 500 `{ error: 'Interner Fehler.' }` (logged)
    - static: `/` → `index.html`, `/start` → `start.html`, files under `publicDir` only (no `..` traversal), correct MIME for html/css/js/otf/svg/png
  - WS `/live`: on connect send `{ type: 'state', state, display }`; broadcast the same on store `'change'` and display `'status'`; client message `{ type: 'preview', on: boolean }` adds/removes the socket as a viewer; frames sent as binary. Heartbeat: `ws.ping` every `pingInterval`, terminate sockets without `pong`; `close`/`error`/terminate → `removeViewer`.
  - `bin/pi-anzeige.js`: reads env (Global Constraints), wires `Cdp` → `createStore` → `createDisplay({ startUrl: 'http://127.0.0.1:' + PORT + '/start' })` → `createPreview` → `createServer`, `cdp.start()`, `display.apply()`, logs `Pi-Anzeige listening on :PORT`.

- [ ] **Step 1: Failing tests** (server on port 0, real store, fake display/preview objects with recorded calls):
  - `GET /api/state` shape; `PUT /api/current {url:'ftp://x'}` → 400 with the German message; `{pageId:'nope'}` → 404
  - page CRUD round-trip, `DELETE` → 204
  - malformed JSON → 400; `GET /../package.json` → 404; `GET /` → 200 `text/html`
  - WS: receives initial state; after `PUT /api/black {black:true}` receives a state message with `black: true`
  - WS `{type:'preview',on:true}` → `preview.addViewer` called; `on:false` → `removeViewer`
  - **Review Focus 3:** client that stops answering pings (`ws._socket.pause()` or a raw socket that never pongs) with `pingInterval: 200` → `removeViewer` called within 1 s
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Smoke: `PI_ANZEIGE_DATA=./data/config.json PORT=8080 CDP_PORT=<launched chromium port> node bin/pi-anzeige.js`, `curl localhost:8080/api/state` returns `display.connected: true`. Commit `feat: add http and websocket server`.

### Task 6: Control panel and start page

**Files:**
- Create: `public/index.html`, `public/app.css`, `public/app.js`, `public/start.html`, `public/fonts/bedstead.otf`, `public/fonts/LICENSE-bedstead.txt`, `test/ui.test.js`
- Reference: mock-up https://claude.ai/artifact/SNVQ27yA6ZMcrhQ11R9NBW (spec §6). Use the *impeccable* skill (craft-floor before editing, detector after) and *ui-ux-pro-max* checklist.

**Interfaces:**
- Consumes: REST + WS from Task 5.
- Behaviour (all copy German, exactly as in the mock-up unless listed):
  - Layout, palette tokens, Bedstead/system-mono type, header row with clock + `P<number>`/`P---`, mosaic strip, preview frame in the screen's aspect ratio (`display.screen`, fallback 16:9), page index, URL form, zoom control, four fastext keys. No example scenes: the preview shows the received JPEG (`<img>` with object URL, previous URL revoked).
  - Header status text: `VERBUNDEN` (green) / `VERBINDET NEU` (yellow, WS down or `display.connected === false`) / `SEITE NICHT ERREICHBAR` (red, `display.error`).
  - Preview: sends `{type:'preview',on:true}` on WS open when not paused and the tab is visible; `on:false` on pause and on `visibilitychange` to hidden. Meta line: `LIVE` / `PAUSIERT`, `Letztes Bild HH:MM:SS`, `W × H`.
  - Black: red key `SCHWARZ` / `LICHT AN` (`aria-pressed`), preview overlay text `SCHWARZ AKTIV`.
  - Digit entry 101–199 (2.5 s timeout), keys `B`, `R`, `S`, `0`; ignored while typing in inputs or with modifiers.
  - Page form (green): create (`Als <n> speichern`) and edit mode (`Speichern`, `Löschen` with inline confirm `Wirklich löschen?` → `Ja, löschen` / `Abbrechen`; no `confirm()`). Each index row has an `Ändern` text button (visible on hover/focus ≥ 900 px, always below).
  - Empty state: no pages → index shows `Noch keine Seiten. Adresse eingeben und mit Grün speichern.`
  - Zoom: −/+ 5 %, slider debounced 150 ms; `Zoom übernehmen` row when current page's saved zoom differs.
  - Changes from elsewhere: a state change not caused by this tab marks the affected row magenta (`.flag`) until it is hovered or focused.
  - API errors shown next to the field that caused them (`.err`), network errors in the header status.
  - `start.html`: full-screen teletext page for the kiosk, `P100 PI-ANZEIGE`, large text `Steuerung: http://anzeige.local` and the Pi's LAN address (fetched from `GET /api/info` → `{ hostname, addresses: string[] }`, add this route in `server.js` with a test).
- [ ] **Step 1: Failing Playwright tests** (`test/ui.test.js`, server from Task 5 with real store and fake display/preview that emits a fixed JPEG on addViewer): page loads with no console errors; typing `102` with two saved pages calls `PUT /api/current {pageId}` and marks row 102 `aria-current="true"`; `B` toggles `aria-pressed`; invalid URL shows the German error; create → edit → delete page flow; pause sends `on:false`; second browser context changing black flags nothing but updates the key in the first; no horizontal scroll at 390 px.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Screenshots desktop 1440 + mobile 390 into `.impeccable/review/`; run `impeccable detect --json public/`; fix mechanical findings. Commit `feat: add teletext control panel and kiosk start page`.

### Task 7: Pi deployment, CI and README

**Files:**
- Create: `deploy/install.sh`, `deploy/kiosk.service`, `deploy/pi-anzeige.service`, `deploy/chromium-kiosk.sh`, `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- `install.sh` (bash, `set -euo pipefail`, must run as root, idempotent):
  1. `apt-get install -y cage chromium nodejs npm fonts-dejavu-core` (fall back to `chromium-browser` if `chromium` has no candidate); abort with a clear message if `node --version` < 20.
  2. users: `kiosk` (groups `video,render,input,tty`), `pi-anzeige` (system, no login); dirs `/var/lib/pi-anzeige` (owner `pi-anzeige`) and `/var/lib/pi-anzeige-kiosk` (owner `kiosk`).
  3. `rsync` repo (without `.git`, `test`, `docs`) to `/opt/pi-anzeige`, `npm ci --omit=dev` there.
  4. install both units, `systemctl disable getty@tty1`, `enable --now pi-anzeige kiosk`.
  5. add `consoleblank=0` to `/boot/firmware/cmdline.txt` once.
  6. print `Fertig. Steuerung: http://<hostname>.local`.
- `kiosk.service`: `User=kiosk`, `PAMName=login`, `TTYPath=/dev/tty1`, `TTYReset=yes`, `TTYVHangup=yes`, `UtmpIdentifier=tty1`, `StandardInput=tty`, `Environment=WLR_LIBINPUT_NO_DEVICES=1`, `ExecStart=/usr/bin/cage -s -- /opt/pi-anzeige/deploy/chromium-kiosk.sh`, `Restart=always`, `RestartSec=2`, `After=pi-anzeige.service systemd-user-sessions.service`, `Conflicts=getty@tty1.service`.
- `chromium-kiosk.sh`: execs chromium with the spec §7 flags plus `--ozone-platform=wayland --disk-cache-size=33554432 --user-data-dir=/var/lib/pi-anzeige-kiosk/chromium http://127.0.0.1/start`.
- `pi-anzeige.service`: `User=pi-anzeige`, `AmbientCapabilities=CAP_NET_BIND_SERVICE`, `Environment=PORT=80 PI_ANZEIGE_DATA=/var/lib/pi-anzeige/config.json`, `ExecStart=/usr/bin/node /opt/pi-anzeige/bin/pi-anzeige.js`, `Restart=always`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/pi-anzeige`.
- CI: ubuntu-latest, Node 20, `npm ci`, `npx playwright install --with-deps chromium`, `npm test`, plus `shellcheck deploy/*.sh`.
- README (English): what it is, screenshot, Pi setup (Imager settings, `git clone`, `sudo ./deploy/install.sh`), update, on-Pi checklist from spec §8, troubleshooting (`journalctl -u kiosk -u pi-anzeige`).

- [ ] **Step 1:** `shellcheck deploy/*.sh` clean; `systemd-analyze verify deploy/*.service` (if available) without errors other than missing paths.
- [ ] **Step 2:** Push branch, CI green.
- [ ] **Step 3:** Commit `chore: add pi installer, systemd units, ci and readme`.

---

## Final

- [ ] Whole-branch review (superpowers:requesting-code-review), impeccable finish review on the panel, push `main`.
- [ ] Owner runs the on-Pi checklist; issues found there go through superpowers:systematic-debugging.
