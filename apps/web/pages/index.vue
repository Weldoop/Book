<script setup lang="ts">
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { LibraryView, PlayView } from "~/shared/play";
import { capMessage, cleanAccount, richText } from "~/shared/play";

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
const debugOpen = ref(false);
const logEl = ref<HTMLElement | null>(null);
const composerEl = ref<HTMLTextAreaElement | null>(null);
const textSize = ref("19px");
const themeName = ref<"light" | "dark">("light");

const sizes = ["17px", "19px", "21px", "24px"];
const capped = computed(() => (library.value ? capMessage(library.value.spentUsd, library.value.capUsd) : null));
const lastPlayerIndex = computed(() => {
  const lines = view.value?.lines ?? [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]?.kind === "player") return i;
  }
  return -1;
});

function token(): string | null {
  return session.value?.access_token ?? null;
}

function problem(err: unknown): string {
  if (err && typeof err === "object") {
    const data = (err as { data?: { error?: unknown } }).data;
    if (typeof data?.error === "string" && data.error.trim()) return data.error;
  }
  return "That did not go through. Try again in a moment.";
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
    view.value = await api<PlayView>(`/api/saves/${id}`);
    draft.value = "";
    if (window.matchMedia("(max-width: 959px)").matches) leftOpen.value = false;
  } catch (err) {
    fault.value = problem(err);
  } finally {
    busy.value = false;
  }
}

async function newGame(configId: string): Promise<void> {
  fault.value = "";
  editing.value = false;
  busy.value = true;
  try {
    view.value = await api<PlayView>("/api/saves", { configId });
    draft.value = "";
    await loadLibrary();
    if (window.matchMedia("(max-width: 959px)").matches) leftOpen.value = false;
  } catch (err) {
    fault.value = problem(err);
  } finally {
    busy.value = false;
  }
}

async function send(): Promise<void> {
  if (!view.value || busy.value || capped.value) return;
  if (view.value.ended && !editing.value) return;
  const path = editing.value ? `/api/saves/${view.value.id}/redo` : `/api/saves/${view.value.id}/turn`;
  fault.value = "";
  busy.value = true;
  try {
    view.value = await api<PlayView>(path, { input: draft.value });
    draft.value = "";
    editing.value = false;
    await loadLibrary();
  } catch (err) {
    fault.value = problem(err);
  } finally {
    busy.value = false;
  }
}

function fitComposer(): void {
  const el = composerEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
}

async function startEdit(): Promise<void> {
  if (!view.value?.lastInput || busy.value || capped.value) return;
  editing.value = true;
  draft.value = view.value.lastInput;
  rightOpen.value = false;
  debugOpen.value = false;
  await nextTick();
  fitComposer();
  const el = composerEl.value;
  if (!el) return;
  el.focus();
  const end = el.value.length;
  el.setSelectionRange(end, end);
}

function stopEdit(): void {
  editing.value = false;
  draft.value = "";
  void nextTick(fitComposer);
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
  editing.value = false;
  draft.value = "";
  fault.value = "";
  leftOpen.value = false;
  rightOpen.value = false;
  debugOpen.value = false;
}

function narrowScreen(): boolean {
  return window.matchMedia("(max-width: 959px)").matches;
}

function toggleSaves(): void {
  leftOpen.value = !leftOpen.value;
  if (leftOpen.value && narrowScreen()) {
    rightOpen.value = false;
    debugOpen.value = false;
  }
}

function toggleMenu(): void {
  rightOpen.value = !rightOpen.value;
  if (!rightOpen.value) debugOpen.value = false;
  if (rightOpen.value && narrowScreen()) leftOpen.value = false;
}

function closeMenu(): void {
  rightOpen.value = false;
  debugOpen.value = false;
}

function closePanels(): void {
  leftOpen.value = false;
  closeMenu();
}

function cycleSize(): void {
  const next = sizes[(sizes.indexOf(textSize.value) + 1) % sizes.length] ?? "19px";
  textSize.value = next;
  document.documentElement.style.setProperty("--reading-size", next);
  localStorage.setItem("book-text-size", next);
}

function toggleTheme(): void {
  const next = themeName.value === "dark" ? "light" : "dark";
  themeName.value = next;
  if (next === "light") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  localStorage.setItem("book-theme", next);
}

watch(
  () => view.value?.lines.length,
  async () => {
    await nextTick();
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
  },
);

watch(draft, async () => {
  await nextTick();
  fitComposer();
});

watch(busy, async (isBusy) => {
  if (!isBusy) return;
  await nextTick();
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
});

onMounted(async () => {
  const storedSize = localStorage.getItem("book-text-size");
  if (storedSize && sizes.includes(storedSize)) textSize.value = storedSize;
  themeName.value = localStorage.getItem("book-theme") === "dark" ? "dark" : "light";
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
    fault.value = problem(err);
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
      <button class="icon" type="button" :aria-expanded="leftOpen" @click="toggleSaves">Saves</button>
      <div class="top-center">
        <div class="title">{{ view?.title || "book" }}</div>
        <div v-if="library" class="chip">${{ library.spentUsd.toFixed(2) }} of ${{ library.capUsd.toFixed(0) }}</div>
      </div>
      <button class="icon" type="button" :aria-expanded="rightOpen" @click="toggleMenu">Menu</button>
    </header>
    <div class="stage">
      <button v-if="leftOpen || rightOpen" class="scrim" type="button" aria-label="Close panels" @click="closePanels" />
      <aside class="panel left" :class="{ open: leftOpen }">
        <div class="side-head">
          <h2>New game</h2>
          <button class="icon" type="button" @click="leftOpen = false">Close</button>
        </div>
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
        <div ref="logEl" class="log">
          <p v-if="!view" class="empty">Choose a book, or open one of your saves.</p>
          <p
            v-for="(line, index) in view?.lines ?? []"
            :key="index"
            :class="[line.kind, { 'being-edited': editing && index === lastPlayerIndex }]"
          >
            <template v-for="(part, partIndex) in richText(line.text)" :key="partIndex">
              <strong v-if="part.bold">{{ part.text }}</strong>
              <template v-else>{{ part.text }}</template>
            </template>
          </p>
        </div>
        <form class="dock" :aria-busy="busy" @submit.prevent="send">
          <p v-if="busy" class="turning" role="status" aria-live="polite">The page is turning…</p>
          <template v-else>
            <div v-if="view && !editing && view.suggestions.length" class="offers">
              <button v-for="offer in view.suggestions" :key="offer" type="button" @click="useSuggestion(offer)">
                {{ offer }}
              </button>
            </div>
            <div v-if="editing" class="edit-row">
              Editing the last message you sent. Send plays that turn again.
              <button type="button" @click="stopEdit">Cancel</button>
            </div>
          </template>
          <div class="composer">
            <textarea
              ref="composerEl"
              v-model="draft"
              rows="1"
              :disabled="!view || busy || !!capped || (view.ended && !editing)"
              :placeholder="view ? (editing ? 'Edit your last message' : 'What you do') : 'Open a save first'"
              autocomplete="off"
              enterkeyhint="send"
              aria-label="What you do"
              @keydown.enter.exact.prevent="send"
            />
            <button class="primary" type="submit" :disabled="!view || busy || !!capped">Send</button>
          </div>
          <div v-if="view?.lastInput && !editing && !busy" class="edit-row">
            <button type="button" :disabled="!!capped" @click="startEdit">Edit last message</button>
          </div>
          <p v-if="capped" class="fault">{{ capped }}</p>
          <p v-else-if="fault" class="fault">{{ fault }}</p>
        </form>
      </section>
      <aside class="panel right" :class="{ open: rightOpen }">
        <div class="side-head">
          <h2>{{ debugOpen ? "Debug" : "Menu" }}</h2>
          <button class="icon" type="button" @click="debugOpen ? (debugOpen = false) : closeMenu()">
            {{ debugOpen ? "Back" : "Close" }}
          </button>
        </div>
        <nav v-if="!debugOpen" class="menu-list" aria-label="Menu">
          <button type="button" @click="cycleSize">
            <span>Text size</span>
            <small>{{ textSize }}</small>
          </button>
          <button type="button" @click="toggleTheme">
            <span>Theme</span>
            <small>{{ themeName === "dark" ? "Dark" : "Light" }}</small>
          </button>
          <button type="button" @click="debugOpen = true">
            <span>Debug</span>
            <small aria-hidden="true">›</small>
          </button>
          <button type="button" @click="signOut">
            <span>Sign out</span>
          </button>
        </nav>
        <div v-else-if="view" class="debug">
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
