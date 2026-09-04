import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Define the allowed origins for CORS
const ALLOWED_ORIGINS = new Set([
  'https://www.sleepapneaimplant.org',
  'https://sleepapneaimplant.org',
])

// The client guards against double-clicks, but network-level retries can
// still deliver the same submission twice. An identical record arriving
// within this window is treated as already accepted and not re-inserted.
const DUPLICATE_WINDOW_MS = 30_000

// ---------------------------------------------------------------------------
// Request limits.
//
// The Origin check is NOT authentication: any non-browser client can forge
// the header. What keeps the dataset clean is that every field is validated,
// size-capped and rebuilt below, so a forged request can only insert a
// well-formed row, and the throttle keeps one client from inserting many of
// them. Nothing in this file logs the payload itself.
// ---------------------------------------------------------------------------

// A real submission from the site is 2-6 KB. 64 KB leaves room for a long
// brief and rejects anything that is not a decision-tool payload.
const MAX_BODY_BYTES = 64 * 1024

// Best-effort per-address throttle. Vercel functions are ephemeral, so this
// map lives only as long as the instance and is not shared across instances
// or regions: it blunts a naive flood from one address and nothing more. A
// durable limiter (Vercel WAF rate limiting, or Upstash/Redis) is the real
// fix if abuse ever shows up in the table.
// Only submissions that pass validation are counted, so a flood of garbage
// cannot lock the endpoint for real visitors; garbage is rejected before it
// reaches the counter. The site re-posts whenever the visitor changes an
// answer and presses "See My Result" again, so the per-address cap leaves
// room for that. Both caps can be tuned with environment variables.
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_MAX_PER_IP = Number(process.env.HNS_RATE_MAX_PER_IP) || 40
const RATE_MAX_GLOBAL = Number(process.env.HNS_RATE_MAX_GLOBAL) || 2000
const rateByIp = new Map<string, { count: number; start: number }>()
let globalWindow = { count: 0, start: 0 }

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for') ?? ''
  const first = forwarded.split(',')[0]?.trim()
  return first || request.headers.get('x-real-ip') || 'unknown'
}

/** Read-only: has this address (or the instance as a whole) used up its window? */
function overLimit(ip: string, now: number): boolean {
  if (now - globalWindow.start <= RATE_WINDOW_MS && globalWindow.count >= RATE_MAX_GLOBAL) return true
  const entry = rateByIp.get(ip)
  return !!entry && now - entry.start <= RATE_WINDOW_MS && entry.count >= RATE_MAX_PER_IP
}

/** Count one accepted submission against the address and the instance. */
function recordAccepted(ip: string, now: number): void {
  if (now - globalWindow.start > RATE_WINDOW_MS) globalWindow = { count: 0, start: now }
  globalWindow.count += 1

  if (rateByIp.size > 5000) {
    for (const [key, entry] of rateByIp) {
      if (now - entry.start > RATE_WINDOW_MS) rateByIp.delete(key)
    }
    // A flood from many addresses inside one window: fail open rather than
    // let the map grow without bound.
    if (rateByIp.size > 20_000) rateByIp.clear()
  }
  const entry = rateByIp.get(ip)
  if (!entry || now - entry.start > RATE_WINDOW_MS) rateByIp.set(ip, { count: 1, start: now })
  else entry.count += 1
}

// ---------------------------------------------------------------------------
// Validation. Small, dependency-free, and deliberately strict about shape and
// size rather than about vocabulary: the site's select values change with the
// tool, and a stale enumeration here would silently drop real responses.
// ---------------------------------------------------------------------------

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

class BadInput extends Error {}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * True if the string holds a control character (other than tab, newline or
 * return), a C1 control, a bidi override, a zero-width character or a BOM:
 * none of them belong in a select value, and they can spoof how a row reads
 * in the dashboard or a CSV export.
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true
    if (code >= 127 && code <= 159) return true
    if (code >= 0x200b && code <= 0x200f) return true
    if (code >= 0x2028 && code <= 0x202e) return true
    if (code >= 0x2066 && code <= 0x2069) return true
    if (code === 0xfeff) return true
  }
  return false
}

/**
 * For attribution fields (referrer, landing path, campaign tags): a long or
 * odd value should not cost the visitor their whole response, so these are
 * cleaned and clipped rather than rejected.
 */
function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  let out = ''
  for (let i = 0; i < value.length && out.length < max; i += 1) {
    const ch = value[i]
    if (!hasControlChars(ch)) out += ch
  }
  return out === '' ? null : out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, field: string, max = 64): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new BadInput(`${field} must be a string`)
  if (value.length > max) throw new BadInput(`${field} is too long`)
  if (hasControlChars(value)) throw new BadInput(`${field} contains control characters`)
  return value
}

function num(value: unknown, field: string, min: number, max: number, integer = false): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BadInput(`${field} must be a number`)
  if (integer && !Number.isInteger(value)) throw new BadInput(`${field} must be an integer`)
  if (value < min || value > max) throw new BadInput(`${field} is out of range`)
  return value
}

function bool(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') throw new BadInput(`${field} must be true or false`)
  return value
}

function strArray(value: unknown, field: string, maxItems: number, maxLen = 64): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) throw new BadInput(`${field} must be a list`)
  if (value.length > maxItems) throw new BadInput(`${field} has too many items`)
  return value.map((item, i) => {
    const s = str(item, `${field}[${i}]`, maxLen)
    if (s === null) throw new BadInput(`${field} has an empty item`)
    return s
  })
}

/**
 * Bounded free-form JSON for the jsonb columns (gates, tradeoffs, brief,
 * priorities). Depth, key count, string length and serialized size are all
 * capped and the value is rebuilt key by key, so nothing unexpected reaches
 * the database and prototype-polluting keys are dropped.
 */
function blob(
  value: unknown,
  field: string,
  limits: { maxBytes: number; maxDepth: number; maxKeys: number; maxStr: number }
): Json | null {
  if (value === undefined || value === null) return null
  let keys = 0
  const walk = (node: unknown, depth: number): Json => {
    if (depth > limits.maxDepth) throw new BadInput(`${field} is nested too deeply`)
    if (node === null) return null
    if (typeof node === 'string') {
      if (node.length > limits.maxStr) throw new BadInput(`${field} contains a string that is too long`)
      if (hasControlChars(node)) throw new BadInput(`${field} contains control characters`)
      return node
    }
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new BadInput(`${field} contains a bad number`)
      return node
    }
    if (typeof node === 'boolean') return node
    if (Array.isArray(node)) {
      if (node.length > limits.maxKeys) throw new BadInput(`${field} list is too long`)
      return node.map((item) => walk(item, depth + 1))
    }
    if (isPlainObject(node)) {
      const out: { [key: string]: Json } = {}
      for (const key of Object.keys(node)) {
        if (UNSAFE_KEYS.has(key)) continue
        if (key.length > 64) throw new BadInput(`${field} has a key that is too long`)
        keys += 1
        if (keys > limits.maxKeys) throw new BadInput(`${field} has too many keys`)
        out[key] = walk(node[key], depth + 1)
      }
      return out
    }
    throw new BadInput(`${field} contains an unsupported value`)
  }
  const cleaned = walk(value, 0)
  if (JSON.stringify(cleaned).length > limits.maxBytes) throw new BadInput(`${field} is too large`)
  return cleaned
}

/** The optional "about you" block. Broad ranges only; the form has no free text. */
function demographics(value: unknown) {
  if (!isPlainObject(value)) throw new BadInput('demographics must be an object')
  return {
    ageRange: str(value.ageRange, 'ageRange'),
    sexAtBirth: str(value.sexAtBirth, 'sexAtBirth'),
    raceEthnicity: strArray(value.raceEthnicity, 'raceEthnicity', 16) ?? [],
    country: str(value.country, 'country'),
    state: str(value.state, 'state'),
    bmiRange: str(value.bmiRange, 'bmiRange'),
    insurance: str(value.insurance, 'insurance'),
    cpap: str(value.cpap, 'cpap'),
    stage: str(value.stage, 'stage'),
    heard: str(value.heard, 'heard'),
    consent: true as const,
  }
}

/**
 * JSON.stringify with recursively sorted object keys, so a record compares
 * equal to its JSONB round-trip from Postgres (which reorders keys).
 */
function stableStringify(value: any): string {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']'
  }
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value)
}

function reply(origin: string, status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra }
  if (ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin
  return NextResponse.json(body, { status, headers })
}

/**
 * Handle CORS preflight requests.  For allowed origins the necessary CORS headers
 * are returned; otherwise the request is rejected.
 */
export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin') ?? ''
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new NextResponse(null, { status: 403 })
  }
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}

/**
 * Public endpoint to accept responses from the decision tool. Validates and
 * size-caps the payload, rebuilds it field by field, throttles by address,
 * and writes a record to `public.hns_responses_v2` (V2) or
 * `public.hns_responses` (V1). Implements basic CORS and bot detection.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin') ?? ''
  if (!ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const now = Date.now()
  const ip = clientIp(request)
  if (overLimit(ip, now)) {
    return reply(origin, 429, { error: 'Too many submissions; try again later' }, { 'Retry-After': '600' })
  }

  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return reply(origin, 415, { error: 'Expected application/json' })
  }
  // Early exit on a declared oversize body. A chunked request has no
  // Content-Length and is caught by the byte check below; Vercel's own
  // request-body ceiling (4.5 MB) bounds what can be buffered first.
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    return reply(origin, 413, { error: 'Payload too large' })
  }

  let body: any
  try {
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
      return reply(origin, 413, { error: 'Payload too large' })
    }
    body = JSON.parse(text)
  } catch (err) {
    return reply(origin, 400, { error: 'Invalid JSON body' })
  }
  if (!isPlainObject(body)) {
    return reply(origin, 400, { error: 'Invalid JSON body' })
  }

  // Enforce required consent flag. The site only posts when the visitor's
  // sharing box is ticked; this check enforces shape, the site owns the
  // default state of the box.
  if (!isPlainObject(body.demographics) || body.demographics.consent !== true) {
    return reply(origin, 400, { error: 'Consent is required' })
  }
  // Reject requests that include a honeypot field (simple bot detection)
  if (typeof body.honeypot !== 'undefined' && body.honeypot !== null && body.honeypot !== '') {
    return reply(origin, 400, { error: 'Bot detected' })
  }
  // Validate ratedCount
  const ratedCount = body.ratedCount ?? 0
  if (typeof ratedCount !== 'number' || !Number.isInteger(ratedCount) || ratedCount < 1 || ratedCount > 50) {
    return reply(origin, 400, { error: 'Invalid ratedCount' })
  }

  /**
   * UTM parameters. The site has always sent these FLAT (utm_source,
   * utm_medium, …) at the top level, while this route only ever read them
   * from a nested `body.utm` object — so every UTM column in hns_responses
   * has been null since launch. Read flat first, fall back to nested so an
   * older cached copy of the page still logs correctly.
   */
  const utm = (k: string) =>
    body[`utm_${k}`] ?? (isPlainObject(body.utm) ? body.utm[k] : undefined) ?? null

  /**
   * V2.0 writes to its own table. Owner's call, 2026-08-02: V1 stays frozen
   * and V2 gets columns named for what it actually measures, rather than
   * being squeezed into V1's vocabulary (inspire_score / genio_score / nine
   * 0-10 priorities / a scored adhesive modifier — none of which V2 emits).
   * The two instruments are not comparable and their rows must not be pooled.
   */
  const isV2 = String(body.toolVersion ?? '').startsWith('2')
  const table = isV2 ? 'hns_responses_v2' : 'hns_responses'

  let record: Record<string, unknown>
  try {
    const common = {
      tool_page: str(body.toolPage, 'toolPage', 200),
      referrer_host: clip(body.referrerHost, 253),
      utm_source: clip(utm('source'), 200),
      utm_medium: clip(utm('medium'), 200),
      utm_campaign: clip(utm('campaign'), 200),
      utm_term: clip(utm('term'), 200),
      utm_content: clip(utm('content'), 200),
      demographics: demographics(body.demographics),
    }
    record = isV2
      ? {
          tool_version: str(body.toolVersion, 'toolVersion', 16) ?? '2.0',
          tool_page: common.tool_page,
          referrer_host: common.referrer_host,
          landing_path: clip(body.landingPath, 200),
          utm_source: common.utm_source,
          utm_medium: common.utm_medium,
          utm_campaign: common.utm_campaign,
          utm_term: common.utm_term,
          utm_content: common.utm_content,
          gates: blob(body.gates, 'gates', { maxBytes: 8_000, maxDepth: 3, maxKeys: 80, maxStr: 200 }),
          gate_outcome: str(body.gateOutcome, 'gateOutcome', 32),
          tradeoffs: blob(body.tradeoffs, 'tradeoffs', { maxBytes: 4_000, maxDepth: 3, maxKeys: 40, maxStr: 120 }),
          tradeoffs_answered: ratedCount,
          mri_relevant: bool(body.mriRelevant, 'mriRelevant'),
          lean_toward: str(body.leanToward, 'leanToward', 32),
          lean_percent: num(body.leanPercent, 'leanPercent', 0, 100, true),
          evidence_share: num(body.evidenceShare, 'evidenceShare', 0, 100, true),
          brief: blob(body.brief, 'brief', { maxBytes: 32_000, maxDepth: 6, maxKeys: 600, maxStr: 4_000 }),
          demographics: common.demographics,
        }
      : {
          version: str(body.version, 'version', 16),
          tool_page: common.tool_page,
          referrer_host: common.referrer_host,
          utm_source: common.utm_source,
          utm_medium: common.utm_medium,
          utm_campaign: common.utm_campaign,
          utm_term: common.utm_term,
          utm_content: common.utm_content,
          adhesive_intolerance:
            typeof body.adhesiveIntolerance === 'boolean'
              ? body.adhesiveIntolerance
              : str(body.adhesiveIntolerance, 'adhesiveIntolerance', 32),
          inspire_score: num(body.inspireScore, 'inspireScore', -1_000, 1_000, true),
          genio_score: num(body.genioScore, 'genioScore', -1_000, 1_000, true),
          recommendation: str(body.recommendation, 'recommendation', 64),
          rated_count: ratedCount,
          priorities: blob(body.priorities, 'priorities', { maxBytes: 2_000, maxDepth: 2, maxKeys: 20, maxStr: 64 }),
          // V1 sent an array of {key, label, contribution} objects, not strings.
          top_reasons: blob(body.topReasons, 'topReasons', { maxBytes: 4_000, maxDepth: 2, maxKeys: 60, maxStr: 120 }),
          demographics: common.demographics,
        }
  } catch (err) {
    if (err instanceof BadInput) {
      // The reason is logged; the payload never is.
      console.warn('hns/submit rejected:', err.message)
      return reply(origin, 400, { error: 'Invalid submission' })
    }
    throw err
  }

  // Counted only now: a well-formed submission from this address.
  recordAccepted(ip, now)

  try {
    const supabase = createAdminClient()

    // Idempotency (best effort): if an identical record already arrived within
    // the duplicate window, report success without inserting a second row.
    // Fails open — any error here falls through to the normal insert.
    const since = new Date(now - DUPLICATE_WINDOW_MS).toISOString()
    const { data: recent, error: recentError } = await supabase
      .from(table)
      .select(Object.keys(record).join(','))
      .gte('created_at', since)
    if (!recentError && Array.isArray(recent)) {
      const fingerprint = stableStringify(record)
      if (recent.some((row) => stableStringify(row) === fingerprint)) {
        return reply(origin, 200, { success: true, duplicate: true })
      }
    }

    const { error } = await supabase.from(table).insert(record)
    if (error) {
      // Code and message only: a Postgres error can echo row values.
      console.error('Supabase insert error', error.code, error.message)
      return reply(origin, 500, { error: 'Database error' })
    }
    return reply(origin, 200, { success: true })
  } catch (error) {
    console.error('Unexpected error', error instanceof Error ? error.message : String(error))
    return reply(origin, 500, { error: 'Internal server error' })
  }
}
