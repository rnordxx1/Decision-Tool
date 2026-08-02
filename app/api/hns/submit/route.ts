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
 * Public endpoint to accept responses from the decision tool.  Validates the
 * payload and writes a record to the `public.hns_responses` table.  Implements
 * basic CORS and bot detection.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin') ?? ''
  if (!ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch (err) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Enforce required consent flag
  if (!body?.demographics?.consent) {
    return NextResponse.json({ error: 'Consent is required' }, { status: 400 })
  }
  // Reject requests that include a honeypot field (simple bot detection)
  if (typeof body?.honeypot !== 'undefined' && body.honeypot !== null && body.honeypot !== '') {
    return NextResponse.json({ error: 'Bot detected' }, { status: 400 })
  }
  // Validate ratedCount
  const ratedCount = body?.ratedCount ?? 0
  if (typeof ratedCount !== 'number' || ratedCount < 1) {
    return NextResponse.json({ error: 'Invalid ratedCount' }, { status: 400 })
  }

  /**
   * UTM parameters. The site has always sent these FLAT (utm_source,
   * utm_medium, …) at the top level, while this route only ever read them
   * from a nested `body.utm` object — so every UTM column in hns_responses
   * has been null since launch. Read flat first, fall back to nested so an
   * older cached copy of the page still logs correctly.
   */
  const utm = (k: string) =>
    body[`utm_${k}`] ?? body.utm?.[k] ?? null

  /**
   * V2.0 writes to its own table. Owner's call, 2026-08-02: V1 stays frozen
   * and V2 gets columns named for what it actually measures, rather than
   * being squeezed into V1's vocabulary (inspire_score / genio_score / nine
   * 0-10 priorities / a scored adhesive modifier — none of which V2 emits).
   * The two instruments are not comparable and their rows must not be pooled.
   */
  const isV2 = String(body.toolVersion ?? '').startsWith('2')
  const table = isV2 ? 'hns_responses_v2' : 'hns_responses'

  const record: any = isV2
    ? {
        tool_version: body.toolVersion ?? '2.0',
        tool_page: body.toolPage ?? null,
        referrer_host: body.referrerHost ?? null,
        landing_path: body.landingPath ?? null,
        utm_source: utm('source'),
        utm_medium: utm('medium'),
        utm_campaign: utm('campaign'),
        utm_term: utm('term'),
        utm_content: utm('content'),
        gates: body.gates ?? null,
        gate_outcome: body.gateOutcome ?? null,
        tradeoffs: body.tradeoffs ?? null,
        tradeoffs_answered: ratedCount,
        mri_relevant: typeof body.mriRelevant === 'boolean' ? body.mriRelevant : null,
        lean_toward: body.leanToward ?? null,
        lean_percent: body.leanPercent ?? null,
        evidence_share: body.evidenceShare ?? null,
        brief: body.brief ?? null,
        demographics: body.demographics ?? null,
      }
    : {
        version: body.version ?? null,
        tool_page: body.toolPage ?? null,
        referrer_host: body.referrerHost ?? null,
        utm_source: utm('source'),
        utm_medium: utm('medium'),
        utm_campaign: utm('campaign'),
        utm_term: utm('term'),
        utm_content: utm('content'),
        adhesive_intolerance: body.adhesiveIntolerance ?? null,
        inspire_score: body.inspireScore ?? null,
        genio_score: body.genioScore ?? null,
        recommendation: body.recommendation ?? null,
        rated_count: ratedCount,
        priorities: body.priorities ?? null,
        top_reasons: body.topReasons ?? null,
        demographics: body.demographics ?? null,
      }

  try {
    const supabase = createAdminClient()

    // Idempotency (best effort): if an identical record already arrived within
    // the duplicate window, report success without inserting a second row.
    // Fails open — any error here falls through to the normal insert.
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString()
    const { data: recent, error: recentError } = await supabase
      .from(table)
      .select(Object.keys(record).join(','))
      .gte('created_at', since)
    if (!recentError && Array.isArray(recent)) {
      const fingerprint = stableStringify(record)
      if (recent.some((row) => stableStringify(row) === fingerprint)) {
        return NextResponse.json(
          { success: true, duplicate: true },
          {
            status: 200,
            headers: { 'Access-Control-Allow-Origin': origin },
          }
        )
      }
    }

    const { error } = await supabase.from(table).insert(record)
    if (error) {
      console.error('Supabase insert error', error)
      return NextResponse.json({ error: 'Database error' }, { status: 500 })
    }
    return NextResponse.json(
      { success: true },
      {
        status: 200,
        headers: { 'Access-Control-Allow-Origin': origin },
      }
    )
  } catch (error) {
    console.error('Unexpected error', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}