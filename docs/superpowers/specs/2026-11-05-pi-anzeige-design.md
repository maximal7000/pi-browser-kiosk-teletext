# Pi-Anzeige – Design Spec

Date: 2026-11-05 · Status: awaiting approval

## 1. Goal

A Raspberry Pi 3B with a screen shows any website full-screen. A web control panel on the home network (`http://anzeige.local`) lets the owner set:

- which URL is shown (typed freely or picked from saved pages),
- the zoom level of the shown page,
- black on/off (black overlay; the page keeps running underneath).

A live preview shows the real picture on the screen, but only while at least one control panel is open.

**Success:** switching pages takes seconds without walking to the screen; the preview shows what is really visible; the Pi does no work when nobody is watching.

### Decided (confirmed by the owner)

- Single user, mostly from a PC. No login (trusted home network).
- Raspberry Pi OS **Lite** (64-bit), kiosk via `cage` + Chromium.
- No HDMI-CEC; black = overlay.
- Saved pages (name, URL, zoom) with quick switching.
- Zoom adjustable per page.
- Frontend plain HTML/CSS/JS, no build step; backend Node.js.
- Look: **Teletext** (see section 6).
- UI language German; code, comments, docs, commits and repo in English.
- Code on GitHub: `maximal7000/pi-anzeige` (private).

### Not in v1

Schedules, authentication, multiple displays, HDMI-CEC, access from outside the LAN.

## 2. Architecture

```
Pi 3B (OS Lite)
├─ kiosk.service        cage → chromium --kiosk --remote-debugging-port=9222
│                       (debug port bound to 127.0.0.1 only)
└─ pi-anzeige.service   Node.js server, port 80
    ├─ cdp/             controls Chromium via the DevTools protocol
    ├─ state/           state + persistence (config.json)
    ├─ http/            REST API + static files (public/)
    └─ live/            WebSocket: state push + preview frames
```

Runtime dependencies: Node.js ≥ 20 and the npm package `ws`. Everything else is Node built-ins.

### Units

| Unit | Responsibility | Interface |
|---|---|---|
| `src/state.js` | Loads/saves `config.json` atomically (temp file + rename), validates, emits change events | `get()`, `update(patch)`, `pages.add/edit/remove`, event `change` |
| `src/cdp.js` | Connection to Chromium (`/json` → page target → WebSocket), reconnect with backoff | `navigate(url)`, `setZoom(f)`, `setBlack(bool)`, `startScreencast(opts, onFrame)`, `stopScreencast()`, events `connected`/`disconnected` |
| `src/display.js` | Drives Chromium to the desired state from `state` (URL, zoom, black); re-applies after reconnect/reload | `apply()`, status `{connected, loading, error}` |
| `src/preview.js` | Counts connected panels; starts screencast at ≥ 1, stops at 0; fans out frames | `addClient(ws)`, `removeClient(ws)` |
| `src/server.js` | HTTP + WS, routing, static files | – |
| `public/` | Control panel (HTML/CSS/JS, self-hosted font) | REST + WS |

## 3. Behaviour

### Changing the URL
`Page.navigate`. Chromium is not restarted. Only `http:` and `https:` are accepted; other schemes are rejected.

### Zoom
Behaves like browser zoom (layout is recomputed): `Emulation.setDeviceMetricsOverride` with `width = screenWidth / z`, `height = screenHeight / z`, `deviceScaleFactor = z`. Range 25 %–300 %, 5 % steps. Screen size is read on connect via `Runtime.evaluate(screen.width/height)`. Zoom belongs to what is currently shown; choosing a saved page applies its zoom. When the zoom is changed while a saved page is showing, the panel offers "Zoom übernehmen" to store it on that page.

### Black
Via `Page.addScriptToEvaluateOnNewDocument` plus an immediate `Runtime.evaluate`, a full-viewport black element (closed shadow root, maximum `z-index`) is inserted or removed. It survives reloads and navigation. The page keeps running underneath. The preview then shows black (the screen is the truth), labelled "SCHWARZ AKTIV".

### Live preview
`Page.startScreencast` (JPEG, quality ~60, max 960 px wide). Chromium only emits frames when the picture changes; each frame is acknowledged with `Page.screencastFrameAck`. At most 2 frames/s are forwarded to panels. New panels immediately receive the last frame. With 0 connected panels: `Page.stopScreencast`, no load. Frames go out as binary WS messages, state as JSON text messages. The panel can pause its preview; a paused panel no longer counts as watching. The panel shows the time of the last frame and flags a stale preview.

### Persistence
`config.json` (path via `PI_ANZEIGE_DATA`, default `/var/lib/pi-anzeige/config.json`):

```json
{
  "current": { "url": "https://…", "zoom": 1.0, "pageId": "p1" },
  "black": false,
  "pages": [ { "id": "p1", "number": 101, "name": "Home Assistant", "url": "https://…", "zoom": 1.1 } ]
}
```

Page numbers 101–199 (teletext convention), assigned automatically, editable. After a restart, `display.js` restores the saved state.

## 4. API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Full state + display status |
| PUT | `/api/current` | `{url, zoom?}` or `{pageId}` – show it |
| PUT | `/api/zoom` | `{zoom}` |
| PUT | `/api/black` | `{black: bool}` |
| POST | `/api/reload` | Reload the page |
| GET/POST | `/api/pages` | List / create |
| PUT/DELETE | `/api/pages/:id` | Update / delete |
| WS | `/live` | Server→client: `{"type":"state",…}` on every change; binary: JPEG frames. Client→server: `{"type":"preview","on":bool}` |

Errors: JSON `{error: "<German message for the UI>"}` with 400 (validation) or 503 (Chromium unreachable – state is still saved and applied on reconnect).

## 5. Failure handling

- **Chromium crashed / restarting:** systemd restarts `kiosk.service`; `cdp.js` reconnects with backoff (1 s → max 10 s); `display.js` re-applies URL, zoom, black. Panel shows "VERBINDET NEU".
- **Target page fails to load** (no `Page.loadEventFired` / network error): status "Seite nicht erreichbar", automatic retry after 30 s, 60 s, then every 5 min.
- **Invalid URL / input:** 400 with a clear message shown next to the field.
- **Corrupt config.json:** moved to `config.json.broken-<time>`, start with empty state, warning in the log.
- **Panel loses its WS connection:** automatic reconnect, notice in the header.
- **Several open tabs:** all receive every state change; a change made elsewhere is marked in the page list until seen.

## 6. Control panel – "Teletext" direction

Mode: Operate (a tool). The world contributes type, palette, density and one signature move; layout and controls stay ordinary web controls (buttons, inputs, slider, list). Reference mock-up: https://claude.ai/artifact/SNVQ27yA6ZMcrhQ11R9NBW

- **Palette:** teletext primaries on black: white, yellow, cyan, green, red, blue, magenta. Each colour has a job (yellow = current page, cyan = labels, red = black/live, green = save, blue = reload). No gradients, glass or soft shadows.
- **Type:** Bedstead (public-domain teletext font, self-hosted) for the header row, page numbers, section titles and fastext keys; tabular numerals. Body, inputs and URLs in a system monospace stack so long URLs stay readable.
- **Header row:** `P101  PI-ANZEIGE  VERBUNDEN  Do 05.11.  21:14:07` – ticking clock, current page number, connection status, with a teletext mosaic strip beneath.
- **First viewport (desktop):** large live preview on the left in the screen's aspect ratio with "LIVE", time of last frame, resolution and a pause control; on the right the page index (`101 Home Assistant 110 %`), current page on yellow; below it the URL field and the zoom control (−, slider, +, percentage); at the foot the four **fastext keys**: red "SCHWARZ", green "SPEICHERN", yellow "ZOOM 100 %", blue "NEU LADEN".
- **Signature move:** like a TV set – type digits anywhere on the page: the header counts `P1__` → `P10_` → `P103` and switches. Keys: `B` black, `R` reload, `S` save page, `0` zoom 100 %.
- **Mobile:** same parts stacked, fastext keys pinned at the bottom in a 2×2 grid.
- **States:** no saved pages (hint + URL field first), preview starting, Chromium not connected, page unreachable, black active, preview paused, WS disconnected.
- **Accessibility:** real buttons/labels, visible focus, fastext keys labelled in text (colour never alone), WCAG AA contrast, status messages via `role="status"`, `prefers-reduced-motion` disables the counter animation and the live blink.

Detailed design and build with the *impeccable* and *ui-ux-pro-max* skills.

## 7. Installing on the Pi

`install.sh` in the repo (idempotent), run on a fresh Pi OS Lite:

1. Packages: `cage`, `chromium`, `nodejs`, `npm`, `fonts-dejavu`.
2. User `kiosk` without autologin: `kiosk.service` starts `cage` directly on tty1 (`PAMName=login`, `TTYPath=/dev/tty1`).
3. App to `/opt/pi-anzeige`, `npm ci --omit=dev`.
4. `pi-anzeige.service` (own user, `AmbientCapabilities=CAP_NET_BIND_SERVICE` for port 80, `Restart=always`).
5. Chromium flags: `--kiosk --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=/var/lib/pi-anzeige/chromium`, starting on a local start page.
6. Hide the mouse cursor, disable screen blanking/DPMS.

Update: `git pull && sudo ./install.sh`.

## 8. Testing

- **Unit (node:test):** `state.js` (validation, atomic save, corrupt file), zoom maths, URL validation, page-number assignment, preview client counting.
- **Integration:** real headless Chromium with `--remote-debugging-port` – navigate, zoom, black (pixel check on a screenshot), screencast starts when a panel connects and stops when it leaves, reconnect after a Chromium restart.
- **UI:** Playwright against the running server – page switching, digit entry, fastext keys, error states; desktop + mobile screenshots.
- **CI:** GitHub Actions runs unit and integration tests.
- **On the Pi:** checklist in the README (picture appears, switching, black, preview, state survives reboot).
