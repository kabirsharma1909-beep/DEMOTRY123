# FreeHand Browser

Local-first prototype for voice- and gesture-guided browsing.

## Run locally

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and add `GEMINI_API_KEY` for Gemini-powered command parsing. This is optional for direct commands such as `open YouTube`.
4. Run `npm run dev`.
5. Open `http://localhost:5173`.

The client uses MediaPipe in the browser for hand landmarks. The server currently validates browser actions but does not automate a browser yet. See [PLAN.md](./PLAN.md) for the staged implementation plan.

## Current commands

- `search <query>`
- `scroll down` / `scroll up`
- `back` / `forward`
- `open result <number>`
- `pause`
- `open YouTube` (opens in the default browser)
- `open ChatGPT`, `open github.com`, or `open reddit dot com`
- `scroll down`, `scroll the page up`, or `page down`
- `play lofi hip hop radio on YouTube` (opens the matching YouTube results)
- `open a new tab`
- `close tab` or `press Control W`
- `type hello world`
- `press Control L`, `press Enter`, `press Tab`, or `press ArrowDown`

## Hand controls

- Hold an open palm for 0.3 seconds to scroll down.
- Hold a two-finger point for 0.3 seconds to scroll up.
- Hold a closed fist for 0.35 seconds to click at the current cursor position; open your hand before the next click.
- `open a new tab` opens Google rather than an empty `about:blank` tab.
