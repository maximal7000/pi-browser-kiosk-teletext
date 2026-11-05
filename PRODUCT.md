# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain HTML/CSS/JS frontend, no framework, no build step. Node.js backend on the Pi. Confirmed by the owner.

## Users

One person: the owner of the display. Operates the control panel mostly from a desktop PC in the same home network, occasionally from elsewhere on the LAN. Technically comfortable; no other operators.

## Product Purpose

Pi-Anzeige turns a Raspberry Pi 3B with a screen into a remotely controlled full-screen web display. From a browser on the LAN the owner chooses which website the screen shows, adjusts that site's zoom level, and can blank the screen to black. Success: changing what the screen shows takes seconds, and the owner can see exactly what is on the screen without walking over to it.

## Positioning

The panel controls a real Chromium on the device and shows a live picture of the actual screen, not an approximation. Any website works, including ones that refuse to be embedded in iframes.

## Operating Context

- Display: Raspberry Pi 3B (1 GB RAM), Raspberry Pi OS Lite, `cage` + Chromium kiosk.
- Control: browser tab on a PC at `http://anzeige.local`. No login; trusted home network.
- Live preview runs only while at least one panel tab is open; otherwise the Pi does no capture work.

## Capabilities and Constraints

- Set an arbitrary URL to display.
- Saved pages: name + URL + zoom, one-tap switching, add/edit/delete.
- Zoom level per page, adjustable live.
- Black toggle: black overlay over the page; page keeps running underneath. No HDMI/CEC.
- State (current URL, zoom, black, saved pages) survives reboots.
- Must stay light enough for a Pi 3B.
- Out of scope for v1: schedules, authentication, multiple displays.

## Brand Commitments

Name: "Pi-Anzeige". Must not look AI-generic / templated (explicit owner requirement). UI language: German. Code, docs, commits and repository in English. Visual direction chosen by the owner: Teletext.

## Evidence on Hand

None beyond the product itself. No testimonials, metrics or assets exist; none may be invented.

## Product Principles

1. The screen is the truth: the panel always reflects the real state of the display.
2. One glance, one click: the common actions (switch page, black on/off) are immediate.
3. Respect the hardware: nothing runs on the Pi that nobody is looking at.
4. Calm tool, not a dashboard: no decoration that doesn't help operate the screen.
