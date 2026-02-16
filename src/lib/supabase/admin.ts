import { createClient } from '@supabase/supabase-js'

/**
 * Creates an admin-level Supabase client.  The service role key bypasses
 * Row Level Security (RLS) and should never be exposed to the browser.  Use
 * this only on the server (API routes, route handlers, server components).
 */
export function createAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set')
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
    },
  })
}