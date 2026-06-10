/**
 * End-to-end proof: two real browser contexts, each running the Whist GameSession
 * on top of the LOCAL Kibitz widget (composable-engine branch, headless mode), play
 * a full game to a winner over Kibitz's live P2P data channel — host-authoritative
 * state, client play-intents, bots filling the two empty seats. If this is green,
 * "Whist built entirely on Kibitz" is true end-to-end, not just in unit tests.
 *
 * Run from the whist repo root:  node e2e/game.mjs
 */
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as esbuild from 'esbuild'
import pw from 'playwright'

const { chromium } = pw
const HERE = dirname(fileURLToPath(import.meta.url))
const WIDGET = join(HERE, '..', 'public', 'widget.js')
const PORT = 8807

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('·', ...a)

async function bundleHarness() {
  await esbuild.build({
    entryPoints: [join(HERE, 'harness/entry.ts')],
    bundle: true,
    format: 'esm',
    outfile: join(HERE, 'harness/entry.js'),
    logLevel: 'error',
  })
  log('harness bundled')
}

function serve() {
  const files = {
    '/widget.js': [WIDGET, 'application/javascript'],
    '/entry.js': [join(HERE, 'harness/entry.js'), 'application/javascript'],
  }
  const server = http.createServer(async (req, res) => {
    try {
      const path = req.url.split('?')[0]
      if (path === '/' || path === '/index.html') {
        const body = await readFile(join(HERE, 'harness/index.html'))
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(body)
        return
      }
      const hit = files[path]
      if (hit) {
        const body = await readFile(hit[0])
        res.writeHead(200, { 'content-type': hit[1] })
        res.end(body)
        return
      }
      res.writeHead(404)
      res.end('not found')
    } catch (e) {
      res.writeHead(500)
      res.end(String(e))
    }
  })
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)))
}

async function newPlayer(browser, room, uid, name) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error(`  [${name}] pageerror:`, e.message))
  await page.goto(`http://localhost:${PORT}/?room=${room}&uid=${uid}`)
  await page.waitForFunction(() => !!window.__whist, { timeout: 15000 })
  await page.evaluate((a) => window.__whist.connect(a), { room, uid, name })
  return page
}

const snap = (page) => page.evaluate(() => window.__whist.snapshot())
const roster = (page) => page.evaluate(() => window.__whist.rosterLen())

async function waitFor(label, fn, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true
    await sleep(250)
  }
  throw new Error(`timeout waiting for: ${label}`)
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg)
}

async function main() {
  await bundleHarness()
  const server = await serve()
  log(`serving harness + local widget on :${PORT}`)

  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })

  let ok = false
  try {
    const room = `wq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    log('room', room)
    const alice = await newPlayer(browser, room, 'a-host', 'Alice')
    const bob = await newPlayer(browser, room, 'b-peer', 'Bob')

    log('waiting for both to see each other on the call…')
    await waitFor('roster >= 2 on both', async () => (await roster(alice)) >= 2 && (await roster(bob)) >= 2, 45000)
    log('connected — roster has 2 humans (+2 bot seats)')

    log('waiting for the host to deal…')
    await waitFor('phase playing on both', async () => {
      const a = await snap(alice)
      const b = await snap(bob)
      return a?.phase && a.phase !== 'lobby' && b?.phase && b.phase !== 'lobby'
    }, 30000)

    const dealt = await snap(alice)
    log(`dealt: trump turn=${dealt.turn}, seats=${JSON.stringify(dealt.seatName)}`)
    assert(dealt.seatName.filter(Boolean).length === 4, 'all four seats labelled (2 humans + 2 bots)')

    log('playing the game to completion…')
    const cap = Date.now() + 150000
    let lastProgress = -1
    let stalls = 0
    while (Date.now() < cap) {
      const [a, b] = await Promise.all([snap(alice), snap(bob)])
      if (a?.phase === 'gameOver' && b?.phase === 'gameOver') break
      await Promise.all([
        alice.evaluate(() => window.__whist.playFirstLegal()),
        bob.evaluate(() => window.__whist.playFirstLegal()),
      ])
      const progress = (a?.handNumber ?? 0) * 100 + (a?.tricksWon?.[0] ?? 0) + (a?.tricksWon?.[1] ?? 0)
      if (progress !== lastProgress) {
        if (progress % 100 === 0 || progress - lastProgress > 1) log(`  hand ${a?.handNumber} · scores ${a?.scores} · tricks ${a?.tricksWon}`)
        lastProgress = progress
        stalls = 0
      } else {
        stalls++
      }
      await sleep(stalls > 8 ? 400 : 120)
    }

    const a = await snap(alice)
    const b = await snap(bob)
    log('final A:', JSON.stringify({ phase: a.phase, scores: a.scores, winner: a.winner, hand: a.handNumber }))
    log('final B:', JSON.stringify({ phase: b.phase, scores: b.scores, winner: b.winner, hand: b.handNumber }))

    assert(a.phase === 'gameOver', 'host reached gameOver')
    assert(b.phase === 'gameOver', 'client reached gameOver')
    assert(a.winner !== null, 'a winner was declared')
    assert(a.winner === b.winner, 'host and client agree on the winner')
    assert(JSON.stringify(a.scores) === JSON.stringify(b.scores), 'host and client agree on final scores')
    assert(a.scores[a.winner] >= 5, 'winner reached the game target')
    assert(a.handNumber === b.handNumber, 'host and client agree on hand count')

    ok = true
    console.log('\n✅ PASS — two contexts played a full Whist game over the live Kibitz data channel')
  } catch (e) {
    console.error('\n❌ FAIL —', e.message)
  } finally {
    await browser.close()
    server.close()
  }
  process.exit(ok ? 0 : 1)
}

main()
