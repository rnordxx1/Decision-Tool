import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Define the allowed origins for CORS
const ALLOWED_ORIGINS = new Set([
  'https://www.sleepapneaimplant.org',
  'https://sleepapneaimplant.org',
])

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

  // Prepare record for insertion into Supabase
  const record: any = {
    version: body.version ?? null,
    tool_page: body.toolPage ?? null,
    referrer_host: body.referrerHost ?? null,
    // UTM parameters are optional and stored individually
    utm_source: body.utm?.source ?? null,
    utm_medium: body.utm?.medium ?? null,
    utm_campaign: body.utm?.campaign ?? null,
    utm_term: body.utm?.term ?? null,
    utm_content: body.utm?.content ?? null,
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
    const { error } = await supabase.from('hns_responses').insert(record)
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