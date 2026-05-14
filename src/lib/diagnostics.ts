export type CheckStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skip'

export interface DiagnosticCheck {
  id: string
  label: string
  status: CheckStatus
  detail?: string
  durationMs?: number
}

export interface DiagnosticResult {
  checks: DiagnosticCheck[]
  summary: string
  canRetry: boolean
}

const CHECKS: DiagnosticCheck[] = [
  { id: 'internet', label: 'Internet access', status: 'pending' },
  { id: 'dns', label: 'DNS resolution', status: 'pending' },
  { id: 'api', label: 'API connection', status: 'pending' },
  { id: 'status', label: 'Server status', status: 'pending' },
  { id: 'vault', label: 'Vault state', status: 'pending' },
]

export async function* runDiagnostics(
  apiUrl: string,
  checkVault?: () => Promise<string>,
): AsyncGenerator<DiagnosticResult> {
  const checks = CHECKS.map(c => ({ ...c }))

  const update = (id: string, status: CheckStatus, detail?: string, ms?: number) => {
    const c = checks.find(c => c.id === id)!
    c.status = status
    if (detail) c.detail = detail
    if (ms !== undefined) c.durationMs = ms
  }

  const result = (): DiagnosticResult => ({
    checks: checks.map(c => ({ ...c })),
    summary: buildSummary(checks),
    canRetry: true,
  })

  // 1. Internet access — HEAD beebeeb.io (marketing site, different server)
  update('internet', 'running')
  yield result()
  try {
    const start = Date.now()
    const res = await fetchWithTimeout('https://beebeeb.io', { method: 'HEAD' }, 5000)
    update('internet', res.ok || res.status < 500 ? 'pass' : 'fail', `${res.status}`, Date.now() - start)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : ''
    update('internet', 'fail', msg.includes('timeout') ? 'timeout' : 'unreachable')
  }
  yield result()

  // 2. DNS — implicit in the fetch. If internet passed but API fails with network error, it's DNS-like.
  // We can't do raw DNS in React Native easily, so we infer from the API check.
  update('dns', 'running')
  yield result()
  try {
    const start = Date.now()
    await fetchWithTimeout(`${apiUrl}/health`, { method: 'HEAD' }, 5000)
    update('dns', 'pass', undefined, Date.now() - start)
  } catch {
    // If internet worked but this failed, likely DNS
    const internetOk = checks.find(c => c.id === 'internet')?.status === 'pass'
    if (internetOk) {
      update('dns', 'fail', 'cannot resolve api.beebeeb.io')
    } else {
      update('dns', 'skip', 'no internet')
    }
  }
  yield result()

  // 3. API connection — GET /health
  update('api', 'running')
  yield result()
  try {
    const start = Date.now()
    const res = await fetchWithTimeout(`${apiUrl}/health`, {}, 5000)
    if (res.ok) {
      const data = await res.json().catch(() => null) as { status?: string } | null
      update('api', 'pass', data?.status ?? 'ok', Date.now() - start)
    } else {
      update('api', 'fail', `${res.status} ${res.statusText}`, Date.now() - start)
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : ''
    update('api', 'fail', msg.includes('timeout') ? 'timeout' : 'unreachable')
  }
  yield result()

  // 4. Server status — GET /api/v1/status
  const apiOk = checks.find(c => c.id === 'api')?.status === 'pass'
  if (apiOk) {
    update('status', 'pass', 'operational')
  } else {
    update('status', 'running')
    yield result()
    try {
      const start = Date.now()
      const res = await fetchWithTimeout(`${apiUrl}/api/v1/status`, {}, 5000)
      if (res.ok) {
        const data = await res.json().catch(() => null) as { status?: string } | null
        update('status', 'pass', data?.status ?? 'unknown', Date.now() - start)
      } else {
        update('status', 'fail', `${res.status}`, Date.now() - start)
      }
    } catch {
      update('status', 'fail', 'unreachable')
    }
  }
  yield result()

  // 5. Vault state
  update('vault', 'running')
  yield result()
  if (checkVault) {
    try {
      const state = await checkVault()
      update('vault', 'pass', state)
    } catch {
      update('vault', 'fail', 'error reading vault')
    }
  } else {
    update('vault', 'skip', 'not available')
  }
  yield result()
}

function buildSummary(checks: DiagnosticCheck[]): string {
  const internet = checks.find(c => c.id === 'internet')
  const api = checks.find(c => c.id === 'api')
  const dns = checks.find(c => c.id === 'dns')

  if (internet?.status === 'fail') {
    return 'No internet connection. Check your WiFi or cellular data.'
  }
  if (dns?.status === 'fail') {
    return "Can't resolve api.beebeeb.io. Your DNS might be blocking us."
  }
  if (api?.status === 'fail' && api.detail === 'timeout') {
    return 'Our servers are taking too long to respond. We\'re looking into it.'
  }
  if (api?.status === 'fail') {
    return 'Our servers are temporarily unavailable. Check status.beebeeb.io for updates.'
  }
  if (api?.status === 'pass') {
    return 'Connection restored.'
  }
  return 'Running diagnostics...'
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('timeout')
    throw e
  } finally {
    clearTimeout(timeout)
  }
}
