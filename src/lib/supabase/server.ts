import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'

/**
 * Creates a Supabase client that uses cookie-based auth for server components and route handlers.
 *
 * The anonymous key is used to verify JWT signatures and refresh sessions. It is safe to expose on
 * the server because it is never sent to the client. The cookie store is used to persist and
 * refresh the user's session.
 */
export function createServerSupabaseClient() {
  const cookieStore = cookies()

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

  return createServerClient(
    supabaseUrl,
    anonKey,
    {
      cookies: {
        get(name: string) {
          const value = cookieStore.get(name)
          return value?.value
        },
        set(name: string, value: string, opts: any) {
          cookieStore.set({ name, value, ...opts })
        },
        remove(name: string, opts: any) {
          cookieStore.delete(name, opts)
        },
      },
    }
  )
}