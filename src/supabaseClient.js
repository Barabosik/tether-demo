import { createClient } from "@supabase/supabase-js";

/* The Vite build injects VITE_SUPABASE_* from .env. The esbuild standalone
 * (TETHER.html) has no env — it gets a guest-mode stub instead of a boot
 * crash: auth resolves to "nobody", queries resolve empty, login errors out
 * politely. Every caller already handles those results (guest runs skip
 * submitScore, the modal renders its empty states). */
let env = {};
try { env = import.meta.env || {}; } catch {}
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_ANON_KEY;

function offlineStub() {
  const err = { message: "offline build — no leaderboard backend configured" };
  const q = () => {
    const p = Promise.resolve({ data: [], error: null });
    for (const m of ["select", "eq", "in", "order", "limit", "insert", "update", "upsert"])
      p[m] = q; // every chain step stays awaitable
    p.maybeSingle = () => Promise.resolve({ data: null, error: null });
    return p;
  };
  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithPassword: async () => ({ error: err }),
      signUp: async () => ({ error: err }),
      signOut: async () => ({ error: null }),
    },
    from: q,
  };
}

export const supabase = url && key ? createClient(url, key) : offlineStub();
