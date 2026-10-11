import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockProvider } from "@book/llm";
import type { LLMProvider } from "@book/schema";
import {
  FileSessionLog,
  bundledResumeDir,
  consoleEnv,
  handleTurn,
  readLatestSession,
  replaySessionLog,
  resumeRoot,
  route,
  shownLines,
  MAX_SHOWN_CHARS,
  MAX_SHOWN_LINES,
} from "../src/index.ts";
import type { SessionLog } from "../src/index.ts";

function throwing(): LLMProvider {
  return {
    name: "mock",
    complete: () => {
      throw new Error("the model should not have been called");
    },
  };
}

describe("shownLines", () => {
  it("keeps console lines and drops anything else", () => {
    const lines = shownLines([
      { kind: "story", text: "Hello" },
      { kind: "nope", text: "no" },
      { kind: "note", text: "x".repeat(MAX_SHOWN_CHARS + 5) },
      "string",
      null,
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ kind: "story", text: "Hello" });
    expect(lines[1]?.text).toHaveLength(MAX_SHOWN_CHARS);
    expect(shownLines({ kind: "story", text: "no" })).toEqual([]);
    const many = Array.from({ length: MAX_SHOWN_LINES + 10 }, () => ({ kind: "note", text: "n" }));
    expect(shownLines(many)).toHaveLength(MAX_SHOWN_LINES);
  });
});

describe("replaySessionLog", () => {
  it("keeps the recovered scrollback, then each later turn, and skips a broken row", () => {
    const played = replaySessionLog(
      [
        JSON.stringify({
          type: "recovered",
          title: "Uplands",
          config_id: "uk-life",
          spent_usd: 1,
          lines: [{ kind: "story", text: "Earlier" }],
        }),
        "not json",
        JSON.stringify({
          type: "turn",
          input: "Go check where aisha is",
          spent_usd: 4.5,
          lines: [
            { kind: "story", text: "Aisha is in the kitchen." },
            { kind: "status", text: "Tue 10:47" },
          ],
        }),
      ].join("\n"),
    );
    expect(played.title).toBe("Uplands");
    expect(played.configId).toBe("uk-life");
    expect(played.spentUsd).toBe(4.5);
    expect(played.lines.map((line) => line.text)).toEqual([
      "Earlier",
      "> Go check where aisha is",
      "Aisha is in the kitchen.",
      "Tue 10:47",
    ]);
  });
});

describe("FileSessionLog", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "book-console-"));
    dirs.push(dir);
    return dir;
  }

  it("writes the phone scrollback once, then leaves it in place", async () => {
    const dir = await root();
    const log = new FileSessionLog(dir);
    const started = await handleTurn(
      { game: "uk-life" },
      { llm: new MockProvider(), maxCostUsd: 2, newSaveId: () => "phoneonce" },
    );
    if (!started.ok || "sync" in started) throw new Error("setup turn failed");
    const history = {
      saveId: started.state.save_id,
      configId: "uk-life",
      title: started.title,
      lines: [{ kind: "story" as const, text: "The week already happened." }],
      spentUsd: 0.2,
      state: started.state,
    };
    expect(await log.archive(history)).toBe(true);
    expect(await log.archive({ ...history, lines: [{ kind: "story", text: "a second copy" }] })).toBe(false);
    const transcript = await readFile(join(dir, "phoneonce", "transcript.txt"), "utf8");
    expect(transcript).toContain("The week already happened.");
    expect(transcript).not.toContain("a second copy");
    expect(transcript).toContain("--- on the phone ---");
  });

  it("rejects a save id that could leave the log directory", async () => {
    const log = new FileSessionLog(await root());
    const started = await handleTurn(
      { game: "uk-life" },
      { llm: new MockProvider(), maxCostUsd: 2, newSaveId: () => "phonesafe" },
    );
    if (!started.ok || "sync" in started) throw new Error("setup turn failed");
    await expect(
      log.archive({
        saveId: "../escape",
        configId: "uk-life",
        title: "x",
        lines: [],
        spentUsd: 0,
        state: started.state,
      }),
    ).rejects.toThrow(/Invalid save id/);
  });
});

describe("handleTurn session log", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function log(): Promise<FileSessionLog> {
    const dir = await mkdtemp(join(tmpdir(), "book-console-"));
    dirs.push(dir);
    return new FileSessionLog(dir);
  }

  it("records an opening and the next committed turn, and skips a rejected one", async () => {
    const session = await log();
    const started = await handleTurn(
      { game: "uk-life" },
      { llm: new MockProvider(), maxCostUsd: 2, newSaveId: () => "phoneplay", log: session },
    );
    expect(started.ok).toBe(true);
    if (!started.ok || "sync" in started) return;
    const transcript = await readFile(join(dirs[0]!, "phoneplay", "transcript.txt"), "utf8");
    expect(transcript).toContain("Uplands: A Student Life");
    expect(transcript).toContain("--- turn ");
    const turns = await readFile(join(dirs[0]!, "phoneplay", "turns.jsonl"), "utf8");
    expect(turns.trim().split("\n")).toHaveLength(1);

    const calls: string[] = [];
    const rejecting: SessionLog = {
      archive: () => {
        calls.push("archive");
        return Promise.resolve(false);
      },
      append: () => {
        calls.push("append");
        return Promise.resolve();
      },
    };
    const rejected = await handleTurn(
      { game: "nope", lines: [{ kind: "story", text: "no" }] },
      { llm: throwing(), maxCostUsd: 2, log: rejecting },
    );
    expect(rejected.ok).toBe(false);
    expect(calls).toEqual([]);

    const next = await handleTurn(
      {
        game: "uk-life",
        state: started.state,
        input: "whistle softly",
        spentUsd: started.spentUsd,
        lines: [{ kind: "story", text: "opening scrollback" }],
      },
      { llm: new MockProvider(), maxCostUsd: 2, log: session },
    );
    expect(next.ok).toBe(true);
    const after = await readFile(join(dirs[0]!, "phoneplay", "transcript.txt"), "utf8");
    expect(after).not.toContain("opening scrollback");
    expect(after).toContain("> whistle softly");
    expect((await readFile(join(dirs[0]!, "phoneplay", "turns.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("keeps a finished phone game without calling the model", async () => {
    const session = await log();
    const started = await handleTurn(
      { game: "uk-life" },
      { llm: new MockProvider(), maxCostUsd: 2, newSaveId: () => "phonekept" },
    );
    if (!started.ok || "sync" in started) throw new Error("setup turn failed");
    const synced = await handleTurn(
      {
        game: "uk-life",
        state: started.state,
        spentUsd: started.spentUsd,
        sync: true,
        lines: [
          { kind: "note", text: "> look around" },
          { kind: "story", text: "The house is quiet." },
          { kind: "bad", text: "drop me" },
        ],
      },
      { llm: throwing(), maxCostUsd: 2, log: session },
    );
    expect(synced.ok).toBe(true);
    if (!synced.ok || !("sync" in synced)) throw new Error("expected a sync");
    expect(synced.logged).toBe(true);
    expect(synced.lines).toEqual([]);
    const transcript = await readFile(join(dirs[0]!, "phonekept", "transcript.txt"), "utf8");
    expect(transcript).toContain("> look around");
    expect(transcript).toContain("The house is quiet.");
    expect(transcript).not.toContain("drop me");
    const again = await handleTurn(
      {
        game: "uk-life",
        state: started.state,
        sync: true,
        lines: [{ kind: "story", text: "second upload" }],
      },
      { llm: throwing(), maxCostUsd: 2, log: session },
    );
    if (!again.ok || !("sync" in again)) throw new Error("expected a sync");
    expect(again.logged).toBe(false);
    const still = await readFile(join(dirs[0]!, "phonekept", "transcript.txt"), "utf8");
    expect(still).not.toContain("second upload");
  });

  it("still returns the turn when the log cannot be written", async () => {
    const broken: SessionLog = {
      archive: () => Promise.resolve(false),
      append: () => Promise.reject(new Error("disk full")),
    };
    const started = await handleTurn(
      { game: "uk-life" },
      { llm: new MockProvider(), maxCostUsd: 2, newSaveId: () => "phonebroken", log: broken },
    );
    expect(started.ok).toBe(true);
    if (!started.ok || "sync" in started) return;
    expect(started.state.save_id).toBe("phonebroken");
  });
});

describe("console http log", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("syncs through the route and does not require a model key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "book-console-"));
    dirs.push(dir);
    const started = await handleTurn(
      { game: "pirate" },
      { llm: new MockProvider(), maxCostUsd: 2, newSaveId: () => "phonesync" },
    );
    if (!started.ok || "sync" in started) throw new Error("setup turn failed");
    const res = await route({
      method: "POST",
      url: "/api/turn",
      headers: {},
      body: JSON.stringify({
        game: "pirate",
        state: started.state,
        sync: true,
        lines: [{ kind: "story", text: "The sloop holds." }],
      }),
      env: { BOOK_PROVIDER: "anthropic", BOOK_CONSOLE_LOG: dir },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; sync?: boolean; logged?: boolean };
    expect(body.ok).toBe(true);
    expect(body.sync).toBe(true);
    expect(body.logged).toBe(true);
    const transcript = await readFile(join(dir, "phonesync", "transcript.txt"), "utf8");
    expect(transcript).toContain("The sloop holds.");
    expect(transcript).toContain("Black Water Reckoning");
  });

  it("resumes the newest save and skips a file that is not a save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "book-console-"));
    dirs.push(dir);
    await mkdir(join(dir, "broken"));
    await writeFile(join(dir, "broken", "state.json"), "{", "utf8");
    const started = await handleTurn(
      { game: "uk-life" },
      { llm: new MockProvider(), maxCostUsd: 2, newSaveId: () => "phoneback" },
    );
    if (!started.ok || "sync" in started) throw new Error("setup turn failed");
    const log = new FileSessionLog(dir);
    await log.append({
      saveId: started.state.save_id,
      configId: "uk-life",
      title: started.title,
      input: "Go check where aisha is",
      turn: started.state.turn,
      outcome: "ok",
      lines: [{ kind: "story", text: "Aisha is in the kitchen." }],
      spentUsd: 1.25,
      state: started.state,
    });
    await writeFile(join(dir, "broken", "state.json"), "{", "utf8");
    const saved = await readLatestSession(dir);
    expect(saved?.game).toBe("uk-life");
    expect(saved?.state.turn).toBe(started.state.turn);
    expect(saved?.spentUsd).toBe(1.25);
    expect(saved?.lines.map((line) => line.text)).toEqual([
      "> Go check where aisha is",
      "Aisha is in the kitchen.",
    ]);
    const res = await route({
      method: "GET",
      url: "/api/resume",
      headers: {},
      body: "",
      env: { BOOK_PROVIDER: "mock", BOOK_CONSOLE_LOG: dir, BOOK_CONSOLE_TOKEN: "secret" },
    });
    expect(res.status).toBe(401);
    const open = await route({
      method: "GET",
      url: "/api/resume",
      headers: { authorization: "Bearer secret" },
      body: "",
      env: { BOOK_PROVIDER: "mock", BOOK_CONSOLE_LOG: dir, BOOK_CONSOLE_TOKEN: "secret" },
    });
    expect(open.status).toBe(200);
    const body = JSON.parse(open.body) as { session: { game: string } | null };
    expect(body.session?.game).toBe("uk-life");
    expect(await readLatestSession(join(dir, "missing"))).toBeNull();
  });

  it("resumes the read-only snapshot and leaves it unwritten", async () => {
    const resume = await mkdtemp(join(tmpdir(), "book-resume-"));
    const live = await mkdtemp(join(tmpdir(), "book-live-"));
    dirs.push(resume, live);
    const started = await handleTurn(
      { game: "uk-life" },
      { llm: new MockProvider(), maxCostUsd: 2, newSaveId: () => "phonesnap" },
    );
    if (!started.ok || "sync" in started) throw new Error("setup turn failed");
    const snap = new FileSessionLog(resume);
    await snap.append({
      saveId: started.state.save_id,
      configId: "uk-life",
      title: started.title,
      input: "Walk to the Westbourne",
      turn: started.state.turn,
      outcome: "ok",
      lines: [{ kind: "story", text: "The Westbourne is open." }],
      spentUsd: 6,
      state: started.state,
    });
    const other = await handleTurn(
      { game: "pirate" },
      { llm: new MockProvider(), maxCostUsd: 2, newSaveId: () => "phonelive" },
    );
    if (!other.ok || "sync" in other) throw new Error("setup turn failed");
    await new FileSessionLog(live).append({
      saveId: other.state.save_id,
      configId: "pirate",
      title: other.title,
      input: "Weigh anchor",
      turn: other.state.turn,
      outcome: "ok",
      lines: [{ kind: "story", text: "The sloop holds." }],
      spentUsd: 0.1,
      state: other.state,
    });

    const fromSnap = await route({
      method: "GET",
      url: "/api/resume",
      headers: {},
      body: "",
      env: { BOOK_PROVIDER: "mock", BOOK_CONSOLE_RESUME: resume },
    });
    expect(fromSnap.status).toBe(200);
    expect(JSON.parse(fromSnap.body).session.game).toBe("uk-life");

    const fromLog = await route({
      method: "GET",
      url: "/api/resume",
      headers: {},
      body: "",
      env: { BOOK_PROVIDER: "mock", BOOK_CONSOLE_LOG: live, BOOK_CONSOLE_RESUME: resume },
    });
    expect(JSON.parse(fromLog.body).session.game).toBe("pirate");

    const empty = await route({
      method: "GET",
      url: "/api/resume",
      headers: {},
      body: "",
      env: { BOOK_PROVIDER: "mock" },
    });
    expect(JSON.parse(empty.body).session).toBeNull();

    const before = await readFile(join(resume, "phonesnap", "state.json"), "utf8");
    const posted = await route({
      method: "POST",
      url: "/api/turn",
      headers: {},
      body: JSON.stringify({ game: "uk-life", state: started.state, sync: true, lines: started.lines }),
      env: { BOOK_PROVIDER: "mock", BOOK_CONSOLE_RESUME: resume },
    });
    expect(posted.status).toBe(200);
    expect(JSON.parse(posted.body).logged).toBe(false);
    expect(await readFile(join(resume, "phonesnap", "state.json"), "utf8")).toBe(before);
    expect(resumeRoot({ BOOK_CONSOLE_LOG: live, BOOK_CONSOLE_RESUME: resume })).toBe(live);
    expect(resumeRoot({})).toBeUndefined();
  });
});

describe("vercel resume env", () => {
  it("points the bundle at the snapshot only when no log is set", () => {
    expect(bundledResumeDir("file:///var/task/index.js")).toBe("/var/task/saves");
    expect(consoleEnv({})).toEqual({ BOOK_CONSOLE_RESUME: bundledResumeDir() });
    expect(consoleEnv({ BOOK_CONSOLE_LOG: "  /tmp/live  " })).toEqual({ BOOK_CONSOLE_LOG: "  /tmp/live  " });
    expect(consoleEnv({ BOOK_CONSOLE_RESUME: "/tmp/snap" })).toEqual({ BOOK_CONSOLE_RESUME: "/tmp/snap" });
  });
});
