<script setup lang="ts">
import type { EmailOtpType, SupabaseClient } from "@supabase/supabase-js";

const route = useRoute();
const { $supabase } = useNuxtApp();
const message = ref("Signing you in…");

onMounted(async () => {
  const client = $supabase as SupabaseClient | null;
  if (!client) {
    message.value = "Supabase is not configured.";
    return;
  }
  const described = route.query.error_description;
  if (typeof described === "string" && described.length > 0) {
    message.value = described;
    return;
  }
  const tokenHash = route.query.token_hash;
  const type = route.query.type;
  if (typeof tokenHash === "string" && typeof type === "string") {
    const { error } = await client.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash });
    if (error) {
      message.value = error.message;
      return;
    }
  }
  const code = route.query.code;
  if (typeof code === "string") {
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (error) {
      message.value = error.message;
      return;
    }
  }
  await navigateTo("/");
});
</script>

<template>
  <main class="gate">
    <p>{{ message }}</p>
  </main>
</template>
