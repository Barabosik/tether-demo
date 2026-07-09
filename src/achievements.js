import { supabase } from "./supabaseClient.js";

/* Foundation for user achievements. Requires the `achievements` table +
 * RLS policies described in the Supabase setup SQL (see project notes). */
export async function saveAchievement(achievementName) {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    console.warn("saveAchievement skipped: no authenticated user");
    return null;
  }

  const { data, error } = await supabase
    .from("achievements")
    .insert([{ user_id: user.id, achievement_name: achievementName }])
    .select();

  if (error) {
    console.error("saveAchievement failed:", error.message);
    return null;
  }
  return data[0];
}

// current user's earned achievements, newest first — used by the leaderboard modal
export async function fetchAchievements() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("achievements")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("fetchAchievements failed:", error.message);
    return [];
  }
  return data;
}
