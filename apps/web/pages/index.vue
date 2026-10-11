<script setup lang="ts">
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { HistoryPage, LibraryView, PlayView, TranscriptItem } from "~/shared/play";
import { capMessage, cleanAccount, faultMessage, richText } from "~/shared/play";

interface LogLine {
  key: string;
  kind: TranscriptItem["kind"];
  text: string;
}

const { $supabase } = useNuxtApp();
const supabase = $supabase as SupabaseClient | null;

const session = ref<Session | null>(null);
const ready = ref(false);
const library = ref<LibraryView | null>(null);
const view = ref<PlayView | null>(null);
const draft = ref("");
const email = ref("");
const password = ref("");
const creating = ref(false);
const notice = ref("");
const editing = ref(false);
const busy = ref(false);
const fault = ref("");
const leftOpen = ref(false);
const rightOpen = ref(false);
const logEl = ref<HTMLElement | null>(null);
const transcript = ref<LogLine[]>([]);
const earlier = ref<string | null>(null);
const loadingEarlier = ref(false);
const pinning = ref(false);
let lastScrollTop = 0;
let lineKey = 0;
let viewGen = 0;

const sizes = ["17px", "19px", "21px", "24px"];
const capped = computed(() => (library.value ? capMessage(library.value.spentUsd, library.value.capUsd) : null));

function token(): string | null {
  return session.value?.access_token ?? null;
}

function stamp(lines: TranscriptItem[]): LogLine[] {
  return lines.map((line) => {
    lineKey += 1;
    return { key: `line-${lineKey}`, kind: line.kind, text: line.text };
  });
}

function applyView(next: PlayView): void {
  viewGen += 1;
  view.value = next;
  transcript.value = stamp(next.lines);
  earlier.value = next.before;
  void pinToEnd();
}

async function pinToEnd(): Promise<void> {
  pinning.value = true;
  await nextTick();
  const el = logEl.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
    lastScrollTop = el.scrollTop;
  }
  pinning.value = false;
}

async function loadEarlier(): Promise<void> {
  const cursor = earlier.value;
  const el = logEl.value;
  if (!view.value || !cursor || loadingEarlier.value || !el) return;
  const beforeHeight = el.scrollHeight;
  const beforeTop = el.scrollTop;
  const gen = viewGen;
  loadingEarlier.value = true;
  fault.value = "";
  try {
    const page = await api<HistoryPage>(`/api/saves/${view.value.id}/history?before=${encodeURIComponent(cursor)}`);
    if (gen !== viewGen) return;
    transcript.value = [...stamp(page.lines), ...transcript.value];
    earlier.value = page.before;
    pinning.value = true;
    await nextTick();
    if (gen !== viewGen) return;
    el.scrollTop = el.scrollHeight - beforeHeight + beforeTop;
    lastScrollTop = el.scrollTop;
  } catch (err) {
    fault.value = faultMessage(err);
  } finally {
    pinning.value = false;
    loadingEarlier.value = false;
  }
}

function onLogScroll(): void {
  const el = logEl.value;
  if (!el) return;
  const top = el.scrollTop;
  const movedUp = top + 1 < lastScrollTop;
  lastScrollTop = top;
  if (pinning.value || loadingEarlier.value || busy.value) return;
  if (!movedUp || top > 64 || !earlier.value) return;
  void loadEarlier();
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  return await $fetch<T>(path, {
    method: body === undefined ? "GET" : "POST",
    body,
    headers: token() ? { authorization: `Bearer ${token()}` } : {},
  });
}

async function loadLibrary(): Promise<void> {
  library.value = await api<LibraryView>("/api/library");
}

async function openSave(id: string): Promise<void> {
  fault.value = "";
  editing.value = false;
  busy.value = true;
  try {
    applyView(await api<PlayView>(`/api/saves/${id}`));
    draft.value = "";
    if (window.matchMedia("(max-width: 959px)").matches) leftOpen.value = false;
  } catch (err) {
    fault.value = faultMessage(err);
  } finally {
    busy.value = false;
  }
}

async function newGame(configId: string): Promise<void> {
  fault.value = "";
  editing.value = false;
  busy.value = true;
  try {
    applyView(await api<PlayView>("/api/saves", { configId }));
    draft.value = "";
    await loadLibrary();
    if (window.matchMedia("(max-width: 959px)").matches) leftOpen.value = false;
  } catch (err) {
    fault.value = faultMessage(err);
  } finally {
    busy.value = false;
  }
}

async function send(): Promise<void> {
  if (!view.value || busy.value) return;
  const path = editing.value ? `/api/saves/${view.value.id}/redo` : `/api/saves/${view.value.id}/turn`;
  fault.value = "";
  busy.value = true;
  try {
    applyView(await api<PlayView>(path, { input: draft.value }));
    draft.value = "";
    editing.value = false;
    await loadLibrary();
  } catch (err) {
    fault.value = faultMessage(err);
  } finally {
    busy.value = false;
  }
}

function startEdit(): void {
  if (!view.value?.lastInput) return;
  editing.value = true;
  draft.value = view.value.lastInput;
  rightOpen.value = false;
}

function stopEdit(): void {
  editing.value = false;
  draft.value = "";
}

function useSuggestion(text: string): void {
  if (editing.value) return;
  draft.value = text;
}

async function submitAccount(): Promise<void> {
  if (!supabase || busy.value) return;
  fault.value = "";
  notice.value = "";
  const parsed = cleanAccount(email.value, password.value);
  if (!parsed.ok) {
    fault.value = parsed.error;
    return;
  }
  busy.value = true;
  try {
    if (creating.value) {
      const { data, error } = await supabase.auth.signUp({
        email: parsed.email,
        password: parsed.password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) {
        fault.value = error.message;
        return;
      }
      if (!data.session) {
        notice.value = "Check your email to confirm this account. Then sign in here.";
        creating.value = false;
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({
        email: parsed.email,
        password: parsed.password,
      });
      if (error) fault.value = error.message;
    }
  } finally {
    busy.value = false;
  }
}

async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
  session.value = null;
  view.value = null;
  library.value = null;
  transcript.value = [];
  earlier.value = null;
}

function cycleSize(): void {
  const current = getComputedStyle(document.documentElement).getPropertyValue("--reading-size").trim() || "19px";
  const next = sizes[(sizes.indexOf(current) + 1) % sizes.length] ?? "19px";
  document.documentElement.style.setProperty("--reading-size", next);
  localStorage.setItem("book-text-size", next);
}

function toggleTheme(): void {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  if (next === "light") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  localStorage.setItem("book-theme", next);
}

onMounted(async () => {
  if (window.matchMedia("(min-width: 960px)").matches) leftOpen.value = true;
  if (!supabase) {
    ready.value = true;
    return;
  }
  const { data } = await supabase.auth.getSession();
  session.value = data.session;
  supabase.auth.onAuthStateChange((_event, next) => {
    session.value = next;
  });
  ready.value = true;
});

watch(session, (next, prev) => {
  if (!next || next.user.id === prev?.user.id) return;
  void loadLibrary().catch((err: unknown) => {
    fault.value = faultMessage(err);
  });
});
</script>

<template>
  <main v-if="!ready" class="gate"><p>Opening…</p></main>
  <main v-else-if="!supabase" class="gate">
    <div>
      <h1>book</h1>
      <p>Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY on the server, then start again.</p>
    </div>
  </main>
  <main v-else-if="!session" class="gate">
    <div>
      <h1>book</h1>
      <p>A story that keeps the books. Sign in with your email. Each account has its own saves and five dollars of play.</p>
      <form class="account" @submit.prevent="submitAccount">
        <label for="email">Email</label>
        <input id="email" v-model="email" type="email" autocomplete="email" required />
        <label for="password">Password</label>
        <input
          id="password"
          v-model="password"
          type="password"
          :autocomplete="creating ? 'new-password' : 'current-password'"
          required
        />
        <button class="primary" type="submit" :disabled="busy">{{ creating ? "Create account" : "Sign in" }}</button>
      </form>
      <p class="switch">
        <button type="button" @click="creating = !creating; fault = ''; notice = ''">
          {{ creating ? "Already have an account? Sign in" : "New here? Create an account" }}
        </button>
      </p>
      <p v-if="notice" class="notice">{{ notice }}</p>
      <p v-if="fault" class="fault">{{ fault }}</p>
    </div>
  </main>
  <div v-else class="shell">
    <header class="top">
      <button class="icon" type="button" :aria-expanded="leftOpen" @click="leftOpen = !leftOpen">Saves</button>
      <div class="title">{{ view?.title || "book" }}</div>
      <div v-if="library" class="spent">${{ library.spentUsd.toFixed(2) }} of ${{ library.capUsd.toFixed(0) }}</div>
      <button class="icon" type="button" @click="cycleSize">A</button>
      <button class="icon" type="button" @click="toggleTheme">Theme</button>
      <button class="icon" type="button" :aria-expanded="rightOpen" @click="rightOpen = !rightOpen">Debug</button>
      <button class="icon" type="button" @click="signOut">Sign out</button>
    </header>
    <div class="stage">
      <button v-if="leftOpen || rightOpen" class="scrim" type="button" aria-label="Close panels" @click="leftOpen = false; rightOpen = false" />
      <aside class="panel left" :class="{ open: leftOpen }">
        <div class="side-head"><h2>New game</h2></div>
        <div class="games">
          <button
            v-for="game in library?.games ?? []"
            :key="game.id"
            type="button"
            :disabled="busy || !!capped"
            @click="newGame(game.id)"
          >
            {{ game.title }}
          </button>
        </div>
        <div class="side-head"><h2>Your saves</h2></div>
        <div class="saves">
          <button
            v-for="save in library?.saves ?? []"
            :key="save.id"
            type="button"
            :class="{ active: view?.id === save.id }"
            :disabled="busy"
            @click="openSave(save.id)"
          >
            {{ save.title }}
            <small>Turn {{ save.turn }}{{ save.ended ? " · ended" : "" }}</small>
          </button>
          <p v-if="library && library.saves.length === 0" class="empty">No saves yet.</p>
        </div>
      </aside>
      <section class="story">
        <div ref="logEl" class="log" @scroll="onLogScroll">
          <p v-if="!view" class="empty">Choose a book, or open one of your saves.</p>
          <button v-else-if="earlier" class="earlier" type="button" :disabled="loadingEarlier" @click="loadEarlier">
            {{ loadingEarlier ? "Turning back…" : "Earlier" }}
          </button>
          <p v-for="line in transcript" :key="line.key" :class="line.kind">
            <template v-for="(part, partIndex) in richText(line.text)" :key="partIndex">
              <strong v-if="part.bold">{{ part.text }}</strong>
              <template v-else>{{ part.text }}</template>
            </template>
          </p>
          <p v-if="busy" class="note">The page is turning…</p>
        </div>
        <form class="dock" @submit.prevent="send">
          <div v-if="view && !editing && view.suggestions.length" class="offers">
            <button v-for="offer in view.suggestions" :key="offer" type="button" :disabled="busy" @click="useSuggestion(offer)">
              {{ offer }}
            </button>
          </div>
          <div v-if="editing" class="edit-row">
            Editing your last line. Sending replaces that turn.
            <button type="button" @click="stopEdit">Cancel</button>
          </div>
          <div class="composer">
            <input
              v-model="draft"
              type="text"
              :disabled="!view || busy || !!capped || (view.ended && !editing)"
              :placeholder="view ? (editing ? 'Rewrite your last line' : 'What you do') : 'Open a save first'"
              autocomplete="off"
              enterkeyhint="send"
              aria-label="What you do"
            />
            <button class="primary" type="submit" :disabled="!view || busy || !!capped">Send</button>
          </div>
          <div v-if="view?.lastInput && !editing" class="edit-row">
            <button type="button" :disabled="busy || !!capped" @click="startEdit">Edit last line</button>
          </div>
          <p v-if="capped" class="fault">{{ capped }}</p>
          <p v-else-if="fault" class="fault">{{ fault }}</p>
        </form>
      </section>
      <aside class="panel right" :class="{ open: rightOpen }">
        <div class="side-head">
          <h2>Debug</h2>
          <button class="icon" type="button" @click="rightOpen = false">Close</button>
        </div>
        <div v-if="view" class="debug">
          <p>${{ view.debug.spentUsd.toFixed(2) }} of ${{ view.debug.capUsd.toFixed(0) }} on this account</p>
          <p v-if="view.debug.turn === null">No turn yet.</p>
          <template v-else>
            <p>
              Turn {{ view.debug.turn }} · {{ view.debug.outcome }} · {{ view.debug.calls }} call{{ view.debug.calls === 1 ? "" : "s" }}
            </p>
            <p v-if="view.debug.outcome === 'rolled_back'">Rolled back. The save was left as it was.</p>
            <p>
              in {{ view.debug.inputTokens }} · out {{ view.debug.outputTokens }} · cached {{ view.debug.cachedInputTokens }} · ${{ view.debug.costUsd.toFixed(4) }}
            </p>
            <table>
              <tbody>
                <tr v-for="part in view.debug.parts" :key="part.name">
                  <td>{{ part.name }}{{ part.trimmed ? " (trimmed)" : "" }}</td>
                  <td>{{ part.tokens }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="view.debug.repairs.length === 0">Clean.</p>
            <div v-for="(repair, index) in view.debug.repairs" :key="index" class="repair">
              <strong>{{ repair.kind }}</strong>
              <ul>
                <li v-for="(item, itemIndex) in repair.violations" :key="itemIndex">{{ item.severity }} {{ item.code }}: {{ item.message }}</li>
              </ul>
            </div>
          </template>
        </div>
        <p v-else class="debug empty">Open a save to see the last turn.</p>
      </aside>
    </div>
  </div>
</template>
