/** Words that carry no matter of their own. Overlap is counted on what is left. */
const STOP = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "your",
  "will",
  "before",
  "after",
  "into",
  "over",
  "about",
  "they",
  "them",
  "their",
  "been",
  "were",
  "when",
  "what",
  "where",
  "which",
  "would",
  "could",
  "should",
  "there",
  "here",
  "just",
  "only",
  "also",
  "than",
  "then",
  "some",
  "such",
  "must",
  "need",
  "needs",
  "until",
  "while",
  "because",
  "through",
  "during",
  "under",
  "again",
  "still",
  "back",
  "away",
  "down",
  "more",
  "most",
  "very",
  "like",
  "make",
  "made",
  "does",
  "being",
  "onto",
  "upon",
  "within",
  "without",
  "across",
  "around",
  "among",
  "between",
  "against",
  "every",
  "each",
  "other",
  "another",
  "these",
  "those",
  "someone",
  "something",
  "anything",
  "nothing",
  "everyone",
  "everything",
  "said",
  "says",
  "want",
  "wants",
  "going",
  "come",
  "came",
  "take",
  "took",
  "tell",
  "told",
  "know",
  "knew",
  "think",
  "thought",
  "really",
  "already",
  "please",
  "thanks",
  "towards",
  "toward",
  "shall",
  "might",
  "ought",
]);

export interface ThreadOverlap {
  id: string;
  status: string;
  text: string;
  due?: string | undefined;
}

function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    let word = raw;
    if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) word = word.slice(0, -1);
    if (word.length < 4 || STOP.has(word) || STOP.has(raw)) continue;
    out.add(word);
  }
  return out;
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const word of a) if (b.has(word)) n += 1;
  return n;
}

/**
 * An open thread this text would repeat. Four shared content words is enough on its own.
 * The same deadline needs two, so two events can share a minute without colliding.
 */
export function duplicateOpenThread(threads: readonly ThreadOverlap[], text: string, due?: string): ThreadOverlap | undefined {
  const words = contentWords(text);
  for (const thread of threads) {
    if (thread.status !== "open") continue;
    const shared = sharedCount(words, contentWords(thread.text));
    if (shared >= 4) return thread;
    if (due !== undefined && thread.due === due && shared >= 2) return thread;
  }
  return undefined;
}
