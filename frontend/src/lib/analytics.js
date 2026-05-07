import { supabase } from "./supabase";

export async function trackEvent(user, event, page = null) {
  if (!user) return;
  try {
    await supabase.from("user_events").insert({
      user_id: user.id,
      email:   user.email,
      event,
      page,
    });
  } catch (_) {
    // analytics failures are silent
  }
}

export async function upsertProfile(user) {
  if (!user) return;
  try {
    await supabase.from("profiles").upsert({
      id:           user.id,
      email:        user.email,
      full_name:    user.user_metadata?.full_name ?? null,
      avatar_url:   user.user_metadata?.avatar_url ?? null,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: "id" });
  } catch (_) {}
}
