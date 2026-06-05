import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

/**
 * Service-role client — BYPASSES RLS. Server-only (the `server-only` import
 * makes the build fail if this is ever pulled into a client bundle).
 * Only use it for trusted background work (e.g. the ingestion worker writing
 * chunks); always set `user_id` explicitly when you do.
 */
export function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
