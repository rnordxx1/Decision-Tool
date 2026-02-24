import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

/**
 * Creates a Supabase client that uses cookie-based auth for server components and route handlers.
 */
export function createServerSupabaseClient() {
  const cookieStore = cookies();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  return createServerClient(supabaseUrl, anonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, opts: any) {
        cookieStore.set({ name, value, ...opts });
      },
      remove(name: string, _opts: any) {
        cookieStore.delete(name);
      },
    },
  });
}
