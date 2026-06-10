// Proxy /api/* to the live kibitz.chat so this subdomain shares its signaling
// (/api/signal → signal.kibitz.chat) and TURN relay (/api/turn). The widget fetches
// these same-origin, so we forward them here instead of duplicating any secrets.
export const onRequest = async (context) => {
  const url = new URL(context.request.url)
  const target = `https://kibitz.chat${url.pathname}${url.search}`
  const init = { method: context.request.method, headers: {} }
  const auth = context.request.headers.get('authorization')
  if (auth) init.headers.authorization = auth
  const upstream = await fetch(target, init)
  const headers = new Headers()
  headers.set('content-type', upstream.headers.get('content-type') || 'application/json')
  headers.set('cache-control', upstream.headers.get('cache-control') || 'no-store')
  headers.set('access-control-allow-origin', '*')
  return new Response(upstream.body, { status: upstream.status, headers })
}
