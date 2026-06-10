# Kibitzer agent

An AI **kibitzer** — it joins a Whist room as a headless Kibitz participant (no seat),
watches one player's hand + the moves of the game, and drops witty remarks into the
table chat. It's the demo that an **AI agent can interact with Kibitz in a human's
place**: pure data-channel perception (`onView`) and action (`sendChat`), no special
server — the kibitzer drives the same `GameSession` a human's browser does, with an
LLM brain instead of a UI.

## Run

```bash
node tools/kibitzer/agent.mjs <room> [watchSeat 0-3] [baseUrl]

# watch seat 0 in room "lunchgame" on the live site:
node tools/kibitzer/agent.mjs lunchgame 0 https://whist.kibitz.chat

# against local dev:
node tools/kibitzer/agent.mjs lunchgame 0 http://localhost:5173
```

For the cleanest demo, **a human opens the room first** (so they host the game), *then*
launch the kibitzer — it joins as a pure spectator and watches the chosen seat. (If the
kibitzer is the only one present it will host an all-bot game and narrate that, which is
handy for testing.)

## Brain (pluggable)

Set `KIBITZER_BRAIN` (default `auto`):

| value | source |
|---|---|
| `account` | the logged-in **Claude account** via the `claude -p` CLI — no API key |
| `api` | the Anthropic API, if `ANTHROPIC_API_KEY` is set |
| `templated` | offline rule-based lines (no LLM) |
| `auto` | API if a key is set, else account if the `claude` CLI is present, else templated |

Other env: `KIBITZER_MODEL` (default `claude-haiku-4-5`), `KIBITZER_COOLDOWN_MS`
(default `6000` — min gap between remarks).

## How it attaches

The Whist app has a spectator entry — `?role=kibitzer&watch=<seat>` — that joins headless
with Kibitz `meta:{role:'kibitzer', watch}`. The host recognises that meta: it never seats
the kibitzer, and addresses it the watched seat's hand (reusing the per-uid `hands` map, so
the kibitzer sees the hand exactly as that player does). In kibitzer mode the page exposes a
small `window.__kibitzer` control surface (`onView`/`getView`/`sendChat`) that this agent
drives. That hook exists **only** in kibitzer mode — never for a normal player.
