import { supabase } from "./supabase";

const ADMIN_EMAIL = "manjunathts@gmail.com";

export async function trackEvent(user, event, page = null) {
  if (!user) return;

  // Skip all tracking for the admin
  if (user.email === ADMIN_EMAIL) return;

  // Supabase (existing)
  try {
    await supabase.from("user_events").insert({
      user_id: user.id,
      email:   user.email,
      event,
      page,
    });
  } catch (_) {}

  // GA4 — mirror every event so user flows appear in Google Analytics
  try {
    window.gtag?.("event", event, {
      page_path:  page,
      user_id:    user.id,
    });
  } catch (_) {}
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
