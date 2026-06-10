// The KIBITZER AGENT — an AI that watches one player's hand + the moves of the game
// and drops remarks into the table chat. It is just a headless Kibitz PARTICIPANT
// (the composable-engine controller, ?role=kibitzer) with an LLM brain wired to it —
// the demonstration that an agent can interact with Kibitz in a human's place.
//
// Brain (pluggable, env KIBITZER_BRAIN=auto|account|api|templated, default auto):
//   • account   — the logged-in Claude account via the `claude -p` CLI (no API key)
//   • api       — the Anthropic API, if ANTHROPIC_API_KEY is set
//   • templated — offline rule-based lines (no LLM)
//   auto = api if a key is set, else account if the `claude` CLI is present, else templated.
//
// Usage:  node tools/kibitzer/agent.mjs <room> [watchSeat] [baseUrl]
//   node tools/kibitzer/agent.mjs my-room 0 https://whist.kibitz.chat
//   node tools/kibitzer/agent.mjs my-room 0 http://localhost:5173   (local dev)
import { spawn } from 'node:child_process'
import pw from 'playwright'

const { chromium } = pw
// Room: tolerate someone pasting the whole table URL (…/#lunchgame) — take the bit
// after the last '#'. A plain word is used as-is.
const rawRoom = process.argv[2]
const room = rawRoom && rawRoom.includes('#') ? rawRoom.split('#').pop() : rawRoom
// watch seat 0-3, or 'auto' (default) → the host picks whichever seat the human holds.
const watchArg = process.argv[3] ?? 'auto'
const watch = /^[0-3]$/.test(watchArg) ? Number(watchArg) : 'auto'
// Base origin: explicit arg, else the origin of a pasted URL, else the live site.
let base = process.argv[4]
if (!base && rawRoom && rawRoom.includes('://')) {
  try {
    base = new URL(rawRoom).origin
  } catch {
    /* not a URL */
  }
}
base = (base || 'https://whist.kibitz.chat').replace(/\/+$/, '')
if (!room) {
  console.error('usage: node tools/kibitzer/agent.mjs <room> [watchSeat 0-3] [baseUrl]')
  process.exit(1)
}
const MODEL = process.env.KIBITZER_MODEL || 'claude-haiku-4-5'
const BRAIN = process.env.KIBITZER_BRAIN || 'auto'
const COOLDOWN_MS = Number(process.env.KIBITZER_COOLDOWN_MS || 6000)

// ── Brain backends ───────────────────────────────────────────────────────────
const clean = (s) =>
  (s || '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 160)
    .trim()

function prompt(ctx) {
  const trick = ctx.trick.length ? ctx.trick.map((p) => `${p.by} ${p.card}`).join(', ') : '(no cards yet)'
  const scene = [
    `You are a witty, slightly cheeky kibitzer peering over ${ctx.watching}'s shoulder in a game of Whist.`,
    `Trump is ${ctx.trump}. ${ctx.watching}'s hand right now: ${ctx.hand.join(' ') || '(empty)'}.`,
    `This trick so far: ${trick}.`,
    ctx.lastTrickWinner ? `Last trick went to ${ctx.lastTrickWinner}.` : '',
    ctx.lastCard ? `${ctx.lastCard.by} just played ${ctx.lastCard.card}.` : '',
    `It's ${ctx.turnName}'s turn. Score — N/S ${ctx.scores[0]}, E/W ${ctx.scores[1]}.`,
  ].filter(Boolean)

  if (ctx.kind === 'reply') {
    return [
      ...scene,
      `${ctx.reply.from} just said in the table chat: "${ctx.reply.message}"`,
      `Reply to them directly, in character — one short line (max 25 words), witty but genuinely helpful about the game/their hand if they're asking.`,
      `Plain text only. No quotes, no preamble.`,
    ].join('\n')
  }
  return [
    ...scene,
    `Make ONE short spoken remark (max 12 words) reacting to the play — insightful, teasing, or impressed.`,
    `Plain text only. No quotes, no preamble, no emoji-only replies.`,
  ].join('\n')
}

function claudeAccount(p) {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['-p', p, '--model', MODEL], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve(null)
    }, 30000)
    proc.stdout.on('data', (d) => (out += d))
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? clean(out) : null)
    })
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

async function claudeApi(p) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 60, messages: [{ role: 'user', content: p }] }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return clean(data?.content?.[0]?.text)
  } catch {
    return null
  }
}

const FILLERS = [
  'Bold. Reckless, even.',
  'Saving the good stuff, I see.',
  'That’ll come back to bite you.',
  'Textbook. Almost suspicious.',
  'Hmm. I’d have led the other suit.',
  'Confidence! Or panic. Hard to say.',
  'The table holds its breath.',
  'A safe little card for a safe little soul.',
]
let fillerN = 0
function templated(ctx) {
  const c = ctx.lastCard
  if (ctx.event === 'trick' && ctx.lastTrickWinner) return `${ctx.lastTrickWinner} scoops the trick. Tidy.`
  if (c?.card?.includes('A')) return 'Leading the boss already? Bold.'
  if (ctx.trump !== '—' && c?.card?.endsWith(ctx.trump)) return 'Trumping in — ruthless.'
  if (c?.card?.startsWith('2')) return 'A two? Throwing it away, are we.'
  return FILLERS[fillerN++ % FILLERS.length]
}

async function brain(ctx) {
  const p = prompt(ctx)
  const order =
    BRAIN === 'account'
      ? [claudeAccount]
      : BRAIN === 'api'
        ? [claudeApi]
        : BRAIN === 'templated'
          ? []
          : [claudeApi, claudeAccount] // auto: API (if key) then account
  for (const fn of order) {
    const r = await fn(p)
    if (r) return r
  }
  return templated(ctx)
}

// ── The driver injected into the kibitzer page (runs in the browser) ───────────
function pageDriver(cfg) {
  const SYM = { C: '♣', D: '♦', H: '♥', S: '♠' }
  const RL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }
  const label = (c) => (RL[c.rank] || String(c.rank)) + SYM[c.suit]
  const K = window.__kibitzer
  let lastSig = ''
  let lastChatLen = 0
  let inFlight = false
  let lastAt = 0
  let pendingReply = null // newest human chat line we owe a reply to
  let latest = null // latest view, for re-firing after a call finishes

  // Public game scene, used by both play-comments and chat-replies.
  const scene = (v, extra) => {
    const pub = v.pub
    // The seat we watch: explicit, or (auto) the first human seat (non-bot, non-kibitzer uid).
    const wSeat =
      typeof cfg.watch === 'number'
        ? cfg.watch
        : Math.max(0, pub.seatUid.findIndex((u) => u && !String(u).startsWith('kib')))
    const plays = pub.trick.plays.map((p) => ({ by: pub.seatName[p.seat] || `seat ${p.seat}`, card: label(p.card) }))
    const last = plays.length ? plays[plays.length - 1] : null
    return {
      watching: pub.seatName[wSeat] || 'the table',
      hand: (v.myHand || []).map(label),
      trump: pub.trump ? SYM[pub.trump] : '—',
      turnName: pub.seatName[pub.turn] || `seat ${pub.turn}`,
      trick: plays,
      lastCard: last,
      lastTrickWinner: pub.phase === 'trickComplete' && last ? last.by : null,
      scores: pub.scores,
      tricksWon: pub.tricksWon,
      phase: pub.phase,
      ...extra,
    }
  }

  const run = (ctx) => {
    inFlight = true
    lastAt = Date.now()
    window
      .kibitzThink(ctx)
      .then((remark) => {
        if (remark) K.sendChat(remark)
      })
      .catch(() => {})
      .finally(() => {
        inFlight = false
        if (latest) fire(latest) // drain anything that queued while we were thinking
      })
  }

  // Decide what (if anything) to say for the current view. Chat replies jump the
  // cooldown (someone's talking to us); play-comments stay throttled.
  function fire(v) {
    if (inFlight) return
    if (pendingReply) {
      const reply = pendingReply
      pendingReply = null
      run(scene(v, { kind: 'reply', reply }))
      return
    }
    const pub = v.pub
    if (pub.phase !== 'playing' && pub.phase !== 'trickComplete') return
    const completed = pub.tricksWon[0] + pub.tricksWon[1]
    const sig = `${pub.handNumber}:${completed}:${pub.trick.plays.length}:${pub.phase}`
    if (sig === lastSig) return
    const prev = lastSig
    lastSig = sig
    if (prev === '') return // skip the first snapshot on join
    if (Date.now() - lastAt < cfg.cooldownMs) return
    run(scene(v, { kind: pub.phase === 'trickComplete' ? 'trick' : 'play' }))
  }

  let greeted = false
  K.onView((v) => {
    latest = v
    // Say hello once — but only after we've actually adopted the host's game (seats
    // known + data link up), so the greeting isn't fired into the void pre-connection.
    if (!greeted && v.pub.seatName.some(Boolean)) {
      greeted = true
      const wSeat =
        typeof cfg.watch === 'number'
          ? cfg.watch
          : Math.max(0, v.pub.seatUid.findIndex((u) => u && !String(u).startsWith('kib')))
      const who = v.pub.seatName[wSeat]
      K.sendChat(who ? `👁 Kibitzer here — watching ${who}'s hand. I'll chip in as you play.` : '👁 Kibitzer here — deal me in to watch.')
    }
    // New HUMAN chat (not our own / not another kibitzer, whose uids are kib-prefixed)?
    const chat = v.chat || []
    if (chat.length > lastChatLen) {
      const fresh = chat.slice(lastChatLen).filter((c) => !String(c.by).startsWith('kib'))
      if (fresh.length) {
        const m = fresh[fresh.length - 1]
        pendingReply = { from: m.name, message: m.text }
      }
    }
    lastChatLen = chat.length
    fire(v)
  })
}

// ── Run ────────────────────────────────────────────────────────────────────────
const url = `${base}/?role=kibitzer&watch=${watch}&name=${encodeURIComponent('Kibitzer 👁')}#${room}`
console.log(`kibitzer joining room "${room}" (watch=${watch}) via ${base}`)
console.log(`brain=${BRAIN} model=${MODEL}`)
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage()
page.on('console', (m) => {
  const t = m.text()
  if (/kibitz|error|fail/i.test(t)) console.log('  [page]', t)
})
let remarks = 0
await page.exposeFunction('kibitzThink', async (ctx) => {
  const r = await brain(ctx)
  if (r) {
    remarks++
    console.log(`  💬 (${remarks}) ${r}`)
  }
  return r
})
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForFunction(() => !!window.__kibitzer, { timeout: 30000 })
console.log('kibitzer connected — watching the table. (Ctrl-C to stop)')
await page.evaluate(pageDriver, { watch, cooldownMs: COOLDOWN_MS })
// Stay alive until killed.
await new Promise(() => {})
