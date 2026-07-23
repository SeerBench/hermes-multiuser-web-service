/**
 * Hermes Platform SaaS — 10 VU baseline load test (no real LLM chat).
 *
 * Usage:
 *   k6 run -e BASE_URL=http://127.0.0.1:8700 \
 *     -e EMAIL=load@example.com -e PASSWORD='long-password' \
 *     deploy/loadtest/k6-platform.js
 *
 * Optional:
 *   -e GATEWAY_URL=http://127.0.0.1:8643   (default: same host as BASE_URL, port 8643 if BASE is :8700)
 *   -e SKIP_REGISTER=1                     (login only; account must already exist)
 *   -e VUS=10 -e DURATION=2m
 */

import http from 'k6/http'
import { check, group, sleep } from 'k6'
import { Trend, Rate } from 'k6/metrics'

const healthTrend = new Trend('platform_healthz_ms')
const errorRate = new Rate('platform_errors')

const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:8700').replace(/\/$/, '')
const EMAIL = __ENV.EMAIL || 'loadtest@example.com'
const PASSWORD = __ENV.PASSWORD || 'loadtest-password-123'
const SKIP_REGISTER = (__ENV.SKIP_REGISTER || '') === '1'

function defaultGatewayUrl() {
  if (__ENV.GATEWAY_URL) return __ENV.GATEWAY_URL.replace(/\/$/, '')
  try {
    const u = new URL(BASE)
    if (u.port === '8700') {
      u.port = '8643'
      return u.toString().replace(/\/$/, '')
    }
  } catch (_) {
    /* keep BASE */
  }
  return BASE
}

const GATEWAY = defaultGatewayUrl()

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '2m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    platform_healthz_ms: ['p(95)<200'],
    platform_errors: ['rate<0.01'],
  },
}

function jarCookieHeader(jar) {
  // k6 jar applies cookies automatically for matching URLs; keep helper for clarity.
  return jar
}

export function setup() {
  const jar = http.cookieJar()
  const loginUrl = `${BASE}/api/v1/auth/login`
  const registerUrl = `${BASE}/api/v1/auth/register`
  const payload = JSON.stringify({ email: EMAIL, password: PASSWORD })
  const headers = { 'Content-Type': 'application/json' }

  if (!SKIP_REGISTER) {
    const reg = http.post(registerUrl, payload, { headers, jar, redirects: 0 })
    // 200 = created; 400 = likely already exists → fall through to login
    if (reg.status !== 200 && reg.status !== 400) {
      throw new Error(`register failed: ${reg.status} ${reg.body}`)
    }
  }

  const login = http.post(loginUrl, payload, { headers, jar, redirects: 0 })
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status} ${login.body}`)
  }

  // Extract session cookie for gateway (may be different origin/port).
  let session = ''
  const setCookie = login.headers['Set-Cookie'] || login.headers['set-cookie'] || ''
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const c of cookies) {
    const m = String(c).match(/hermes_session=([^;]+)/)
    if (m) {
      session = m[1]
      break
    }
  }
  if (!session) {
    // Fallback: cookie jar for BASE host
    const fromJar = jar.cookiesForURL(BASE)
    if (fromJar.hermes_session && fromJar.hermes_session.length) {
      session = fromJar.hermes_session[0]
    }
  }
  if (!session) {
    throw new Error('hermes_session cookie missing after login')
  }

  return { session }
}

export default function (data) {
  const jar = http.cookieJar()
  jar.set(BASE, 'hermes_session', data.session)
  if (GATEWAY !== BASE) {
    jar.set(GATEWAY, 'hermes_session', data.session)
  }
  jarCookieHeader(jar)

  let failed = false

  group('platform', () => {
    const hz = http.get(`${BASE}/api/v1/healthz`, { jar })
    healthTrend.add(hz.timings.duration)
    const hzOk = check(hz, {
      'healthz 200 or degraded body': (r) =>
        r.status === 200 || (r.status === 503 && r.json('status') === 'degraded'),
      'healthz has checks': (r) => r.json('checks') != null,
    })
    // For load baseline we expect healthy stack → prefer 200
    if (hz.status !== 200) failed = true
    if (!hzOk) failed = true

    const me = http.get(`${BASE}/api/v1/auth/me`, { jar })
    if (!check(me, { 'auth/me 200': (r) => r.status === 200 })) failed = true

    const ws = http.get(`${BASE}/api/v1/workspaces`, { jar })
    if (!check(ws, { 'workspaces 200': (r) => r.status === 200 })) failed = true

    let workspaceId = null
    try {
      const list = ws.json()
      if (Array.isArray(list) && list.length > 0) {
        workspaceId = list[0].id
      }
    } catch (_) {
      /* ignore */
    }

    if (workspaceId) {
      const files = http.get(
        `${BASE}/api/v1/workspaces/${workspaceId}/files`,
        { jar },
      )
      if (!check(files, { 'files 200': (r) => r.status === 200 })) failed = true
    }
  })

  group('gateway', () => {
    const ghz = http.get(`${GATEWAY}/api/healthz`, { jar })
    if (!check(ghz, { 'gateway healthz 200': (r) => r.status === 200 })) {
      failed = true
    }
    const gme = http.get(`${GATEWAY}/api/me`, {
      jar,
      headers: { Cookie: `hermes_session=${data.session}` },
    })
    if (!check(gme, { 'gateway /me 200': (r) => r.status === 200 })) {
      failed = true
    }
  })

  errorRate.add(failed)
  sleep(1)
}
