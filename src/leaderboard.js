import { supabase } from "./supabaseClient.js";

/* Personal-best leaderboard write. Expects a `leaderboard` table with
 * columns: user_id uuid, level_id text, player_name text, time_ms integer,
 * created_at timestamptz default now() — and a unique (user_id, level_id)
 * so each player has exactly one row per level (see project setup SQL).
 *
 * Only ever called for logged-in players (skipped for guests — a
 * per-account leaderboard has no meaningful row to key a guest run to).
 */
function logSupabaseError(where, error) {
  console.error(`submitScore: ${where} failed —`, {
    message: error.message, details: error.details, hint: error.hint, code: error.code,
  });
}

export async function submitScore(levelId, timeMs) {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) { logSupabaseError("getUser", userError); return null; }
  if (!user) { console.warn("submitScore skipped: no authenticated user (guest run)"); return null; }

  const playerName = user.user_metadata?.username || user.email || "Guest";

  const { data: existing, error: selectError } = await supabase
    .from("leaderboard")
    .select("time_ms")
    .eq("user_id", user.id)
    .eq("level_id", levelId)
    .maybeSingle();
  if (selectError) { logSupabaseError("select existing score", selectError); return null; }

  if (!existing) {
    const { data, error } = await supabase
      .from("leaderboard")
      .insert([{ user_id: user.id, level_id: levelId, player_name: playerName, time_ms: timeMs }])
      .select();
    if (error) { logSupabaseError("insert", error); return null; }
    return data[0];
  }

  if (timeMs < existing.time_ms) {
    const { data, error } = await supabase
      .from("leaderboard")
      .update({ time_ms: timeMs, player_name: playerName })
      .eq("user_id", user.id)
      .eq("level_id", levelId)
      .select();
    if (error) { logSupabaseError("update", error); return null; }
    return data[0];
  }

  return existing; // not a new personal best — nothing to write
}

// every recorded time for a level, best (lowest) first — used by the
// leaderboard modal, which scrolls its own row list rather than paging results
export async function fetchLeaderboard(levelId) {
  const { data, error } = await supabase
    .from("leaderboard")
    .select("*")
    .eq("level_id", levelId)
    .order("time_ms", { ascending: true });

  if (error) {
    console.error("fetchLeaderboard failed:", error.message);
    return [];
  }
  return data;
}
