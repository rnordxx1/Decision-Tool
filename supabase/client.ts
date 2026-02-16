import { createBrowserClient } from '@supabase/ssr'

/**
 * Returns a Supabase client for use in browser/client components.
 *
 * Reads the anonymous Supabase URL and key from environment variables.
 * The anonymous key should be safe to expose in the browser since it
 * enforces Row Level Security (RLS) on your Supabase tables.
 */
export function createClient() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY')
  }
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )
}