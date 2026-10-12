import { createClient } from "@supabase/supabase-js";

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig();
  const url = config.public.supabaseUrl;
  const key = config.public.supabaseKey;
  const supabase =
    url && key
      ? createClient(url, key, {
          auth: {
            flowType: "pkce",
            detectSessionInUrl: false,
            persistSession: true,
            autoRefreshToken: true,
          },
        })
      : null;
  return { provide: { supabase } };
});
