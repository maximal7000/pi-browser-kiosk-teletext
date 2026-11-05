# Remote input and quiet kiosk – Design Spec

Date: 2026-11-05 · Status: awaiting approval · Builds on: `2026-11-05-pi-anzeige-design.md`

## 1. Goal

The owner can operate the website on the Pi in two ways:

- **From the control panel:** the live preview is always clickable. Clicks, scrolling and typing go to the page on the Pi (e.g. dismiss a cookie banner, log in).
- **At the Pi:** the touchscreen works directly. No mouse cursor, no on-screen keyboard.

Chromium shows no browser prompts on the kiosk: no translation offer, no password/autofill bubbles, no permission prompts.

**Success:** a click in the preview lands on the same spot of the Pi's page (also when zoomed); text typed into the focused preview appears in the Pi's focused field; no browser bubble ever appears on the kiosk.

### Decided (confirmed by the owner)

- Preview is always clickable (no separate mode).
- Touchscreen at the Pi; cursor hidden (already done); no on-screen keyboard (cage has none); pinch zoom stays disabled.
- Approach: CDP `Input` domain over the existing `/live` WebSocket. No VNC.

## 2. Behaviour

### Pointer
- Panel sends normalized coordinates (`x`, `y` in 0–1 of the preview image area actually showing the frame, i.e. excluding letterbox bars).
- Server maps them to the Pi's viewport including scrollbars (`innerWidth`/`innerHeight` of the top frame, read for every pointer event) and dispatches `Input.dispatchMouseEvent`: `mouseMoved`, `mousePressed`, `mouseReleased` with `button: 'left'`, `clickCount: 1`.
- CSS zoom on the root element does not change the layout viewport, so mapping is zoom-independent.
- Input is dispatched through one queue, in arrival order.
- Wheel (only while the preview is focused, so scrolling the panel never scrolls the display): `Input.dispatchMouseEvent` `type: 'mouseWheel'` at the pointer position with `deltaX`/`deltaY` passed through (clamped to ±2000).
- Clicks outside the frame image (letterbox) are ignored.

### Keyboard
- Clicking the preview focuses it (`tabindex="0"`), shown by a yellow outline and the hint `TASTATUR → PI`. Clicking elsewhere or Tab leaves it.
- While focused, panel shortcuts (digits, `B`, `R`, `S`, `0`) are off; every key is forwarded:
  - printable characters → `Input.insertText`,
  - `Enter`, `Backspace`, `Delete`, `Tab`, `Escape`, arrow keys, `Home`, `End`, `PageUp`, `PageDown` → `Input.dispatchKeyEvent` `rawKeyDown` + `keyUp` with `key`, `code`, `windowsVirtualKeyCode` (Enter also sends `char` with `text: '\r'`),
  - `Ctrl/Cmd+V` → the panel's `paste` event text via `Input.insertText` (max 2000 chars).
- Other modifier combinations are not forwarded.

### Responsiveness
After any input the preview runs at up to 5 frames/s for 10 s, then falls back to 2 frames/s.

### Protocol (client → server on `/live`)
```json
{ "type": "input", "kind": "click", "x": 0.42, "y": 0.17 }
{ "type": "input", "kind": "wheel", "x": 0.5, "y": 0.5, "dx": 0, "dy": 120 }
{ "type": "input", "kind": "text", "text": "hallo" }
{ "type": "input", "kind": "key", "key": "Enter" }
```
Invalid messages (unknown kind, coordinates outside 0–1, unknown key, text > 2000 chars) are dropped silently. Input is only accepted over the WebSocket, which already enforces the Host/Origin checks.

### Quiet kiosk
- `install.sh` writes `/etc/chromium/policies/managed/pi-anzeige.json` (source `deploy/chromium-policy.json`):
  `TranslateEnabled: false`, `PasswordManagerEnabled: false`, `AutofillAddressEnabled: false`, `AutofillCreditCardEnabled: false`, `DefaultNotificationsSetting: 2`, `DefaultGeolocationSetting: 2`, `DefaultBrowserSettingEnabled: false`, `BrowserSignin: 0`, `SpellcheckEnabled: false`, `MetricsReportingEnabled: false`, `PromotionalTabsEnabled: false`, `ForcedLanguages: ["de-DE", "de"]`, `AudioCaptureAllowed: false`, `VideoCaptureAllowed: false`, `DefaultClipboardSetting`/`DefaultWebUsbGuardSetting`/`DefaultSerialGuardSetting`/`DefaultWebHidGuardSetting`/`DefaultWebBluetoothGuardSetting`/`DefaultSensorsSetting`/`DefaultLocalFontsSetting`/`DefaultWindowManagementSetting`/`DefaultFileSystemWriteGuardSetting: 2`, `DownloadRestrictions: 3`. (These bubbles are browser UI: the preview cannot show them and remote input cannot dismiss them.)
- The kiosk script exports `LANGUAGE=de` and `LANG=de_DE.UTF-8` (`--lang` is ignored on Linux).

## 3. Units

| Unit | Change |
|---|---|
| `src/input.js` (new) | `createInput({ cdp })` → `async handle(msg)`: validates a message, maps coordinates, dispatches CDP input. Exports `KEYS` (supported special keys with code/keyCode). |
| `src/preview.js` | `boost(ms = 10000)`: raises the frame cap to 5 fps until `ms` after the last call. |
| `src/server.js` | WS `type: 'input'` → `input.handle(msg)` then `preview.boost()`. |
| `public/app.js`, `public/app.css`, `public/index.html` | Clickable, focusable preview; key/paste/wheel forwarding; focus outline and hint; shortcuts off while focused. |
| `deploy/chromium-policy.json`, `deploy/install.sh`, `deploy/chromium-kiosk.sh` | Policy file install, `--lang=de`. |

## 4. Testing

- **Integration (real headless Chromium):** click hits a button at known coordinates; click still hits it at zoom 2; wheel scrolls (`scrollY > 0`); text lands in a focused input; `Enter` submits a form; invalid messages change nothing.
- **Unit:** `preview.boost()` raises the cap to 5 fps and drops back after the window; server forwards input and boosts.
- **UI (Playwright):** clicking the preview sends normalized coordinates matching the click position; typing while focused sends text/key messages and does not trigger shortcuts; `B` still works when the preview is not focused.
- **Policy:** `deploy/chromium-policy.json` parses and contains `TranslateEnabled: false`.
