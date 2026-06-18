# Whist · on Kibitz

A four-player game of **classic Whist** where the table video call sits right at
each seat — and the entire multiplayer layer (game state *and* video) rides
[**Kibitz**](https://kibitz.chat), the embeddable call + collaboration engine.

This repo is a **reference design**: it shows how to build a real, stateful,
host-authoritative multiplayer app on top of `Kibitz.mount({ headless: true })`
without touching WebRTC, signaling, or reconnect logic yourself. Whist draws its
own table; Kibitz quietly carries the data channel and the media streams.

> Classic Whist, not *Israeli* Whist: no bidding. Trump is the dealer's turned-up
> last card, you must follow suit, and the side that takes more than six tricks
> ("the book") scores the surplus. First to **5** wins.

---

## Why this exists

Kibitz drops a call onto any page. But a call engine is also the hard part of
*any* small multiplayer app: presence, a reliable data channel between peers,
identity that survives reconnects, and an audio/video mesh. If Kibitz exposes
those as a headless controller, a game becomes "just" the game.

Whist is the proof. Everything multiplayer here is **one dependency** — the Kibitz
widget — reached through a thin adapter ([`src/net/kibitz.ts`](src/net/kibitz.ts)):

| Whist needs… | Kibitz gives… |
| --- | --- |
| Send game messages to the table | `controller.broadcast(msg)` |
| Receive others' messages | `controller.onMessage(cb)` |
| Who's at the table (presence) | `controller.getParticipants()` / `on('participants')` |
| Stable identity across reconnects | `mount({ identity })` + `meta.uid` |
| Video at each seat | each participant's `stream` (Kibitz plays the audio) |
| Mic / camera controls | `toggleMic()` / `toggleCam()` |

No signaling server, no TURN config, no `RTCPeerConnection` anywhere in this repo.

---

## Architecture

```
                 ┌─────────────────────────── each player's browser ───────────────────────────┐
                 │                                                                              │
   React table ──┤  App.tsx ── Table.tsx (felt, seats, your hand, video tiles)                  │
   (this repo)   │     │                                                                        │
                 │     ▼                                                                         │
                 │  GameSession (src/net/session.ts) ── pure host-authoritative brain           │
                 │     │            ▲                                                            │
                 │     │ Transport  │ LocalView (what to render)                                 │
                 │     ▼            │                                                            │
                 │  Kibitz adapter (src/net/kibitz.ts)                                           │
                 │     │                                                                         │
                 │  Kibitz.mount({ headless:true })  ──broadcast / onMessage / streams──┐        │
                 └─────┼───────────────────────────────────────────────────────────────┼───────┘
                       └────────────────  P2P data channel + media mesh  ───────────────┘
```

- **One pure engine** ([`src/engine/whist.ts`](src/engine/whist.ts)) — immutable,
  deterministic (seeded shuffle), zero I/O. `deal → legalMoves → playCard →
  nextHand`. Fully unit-tested.
- **One host.** The peer with the lowest stable `uid` is elected host. It owns the
  single authoritative `WhistState`, validates every move, fills empty seats with
  bots, and broadcasts snapshots. Everyone else renders snapshots and sends play
  *intents*. (The host is itself a player; its own moves apply locally.)
- **Resume built in.** Identity rides `meta.uid`, so a player who closes their tab
  and comes back gets their seat and hand back; while they're away their seat is
  played by a bot so the table never stalls. (See the
  [iwhist multiplayer-resume](https://kibitz.chat) lineage.)
- **Bots fill the table.** One human + three bots plays exactly like solo iwhist.
  The bot ([`src/ai/bot.ts`](src/ai/bot.ts)) is a small honest heuristic — a strong
  AI is deliberately out of scope here.

### Trust model (read me)

The data channel is a **shared P2P broadcast** with no per-recipient send, so each
player's cards are *addressed* in the host's snapshot (`hands[uid]`) and a default
client reads only its own entry — a **friendly-table** model, not anti-cheat. A
modified client could read the wire. True secrecy would need server authority or
per-recipient encryption; that's a different product, not this reference design.

---

## Run it

```bash
npm install
npm run dev        # open the printed URL; share the #room link to invite others
```

Empty seats fill with bots, so one browser is a full game. To play multiplayer,
open the same `#room` link in another browser/device and sit down.

> **Widget note.** Headless mode uses the Kibitz *composable-engine* build, which now
> ships on the CDN at `https://kibitz.chat/widget.js`. This reference design still
> **vendors a pinned copy** at [`public/widget.js`](public/widget.js) on purpose — so
> the repo runs standalone and reproducibly, independent of whatever the CDN ships
> next (refresh with `npm run widget`). To track the CDN live instead, point the
> `<script>` in `index.html` at the URL above.

## Test

```bash
npm test           # engine + multiplayer protocol (vitest, in-memory transport)
npm run e2e        # two real browser contexts play a full game over live Kibitz
```

- **`npm test`** — the engine (deal/legal/trick/scoring/full-game) and the protocol
  (4-human game, 2-human-+-2-bot, host election, private hands, illegal-move
  rejection) over an in-memory bus. Fast and deterministic.
- **`npm run e2e`** — bundles the net layer, serves it with the local headless
  widget, launches **two Chromium contexts**, and plays a full Whist game to a
  winner over Kibitz's real WebRTC data channel — the end-to-end proof that the
  game is genuinely built *on* Kibitz.

---

## Deploy

Hosted on Cloudflare Pages (project `kibitz-whist` → **https://kibitz-whist.pages.dev**,
custom domain **whist.kibitz.chat**). The vendored `public/widget.js` ships with the
site, and `functions/api/[[path]].js` proxies `/api/signal` + `/api/turn` to
kibitz.chat so it shares the same reliable self-hosted signaling + TURN relay.

```bash
npm run deploy   # build + wrangler pages deploy
```

## Layout

```
src/engine/   cards.ts, whist.ts            pure rules — no UI, no network
src/ai/       bot.ts                        seat-filling heuristic
src/net/      protocol.ts                   the wire messages (namespaced 'whist')
              session.ts                    host-authoritative brain (transport-agnostic)
              kibitz.ts                     adapter: GameSession Transport ⇄ Kibitz controller
src/ui/       Table, Seat, Card, styles     the felt
e2e/          game.mjs + harness/           browser proof over real Kibitz
```

Built with React + Vite + Vitest. [Apache-2.0](LICENSE).
