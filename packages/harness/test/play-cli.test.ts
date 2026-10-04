import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockProvider } from "@book/llm";
import { MemoryStore } from "@book/store";
import { runCli, runPlay } from "../src/index.ts";
import type { PlayIO } from "../src/index.ts";
import { fakeRuntimeApi, makeConfig } from "./helpers.ts";
import { writeFile } from "node:fs/promises";

function scriptedIO(lines: string[]): PlayIO & { out: string[] } {
  const out: string[] = [];
  const q = [...lines];
  return { out, write: (t) => out.push(t), readLine: async () => q.shift() ?? null, color: false };
}

describe("runPlay", () => {
  it("prints narration, status, tabletop panel, usage line and interludes", async () => {
    const io = scriptedIO(["Start the game", "hello"]);
    const api = fakeRuntimeApi({ outcomeFor: (t) => (t === 2 ? "rewritten" : "ok") });
    await runPlay({ api, config: makeConfig("tabletop"), store: new MemoryStore(), llm: new MockProvider(), saveId: "p", io });
    const text = io.out.join("");
    expect(text).toContain("You Start the game");
    expect(text).toContain("£10 | fine");
    expect(text).toContain("  Money: 10");
    expect(text).toMatch(/\[in \d+  out \d+  cached \d+  \$0\.\d+  \d+\.\ds  ok\]/);
    expect(text).toContain("The moment wobbles.");
    expect(text).toContain("rewritten");
  });

  it("stops between turns when a spend cap is used up and says the save survived", async () => {
    const io = scriptedIO(["one", "two", "three"]);
    const api = fakeRuntimeApi();
    let turns = 0;
    await runPlay({
      api,
      config: makeConfig("light"),
      store: new MemoryStore(),
      llm: new MockProvider(),
      saveId: "p",
      io,
      stopCheck: () => (turns++ >= 1 ? "max-cost-usd $2 reached ($2.0100 spent)" : undefined),
    });
    expect(api.calls).toEqual(["one"]);
    const text = io.out.join("");
    expect(text).toContain("max-cost-usd $2 reached");
    expect(text).toContain("Your save is intact");
  });

  it("shows the roll above the narration when the runtime reports one", async () => {
    const io = scriptedIO(["pick the lock"]);
    const api = fakeRuntimeApi({ roll: { value: 3, band: "Disaster", what: "picking the lock", stat: "dexterity" } });
    await runPlay({ api, config: makeConfig("light"), store: new MemoryStore(), llm: new MockProvider(), saveId: "p", io });
    const text = io.out.join("");
    expect(text).toContain("Fate 3 - Disaster (picking the lock, dexterity)");
    expect(text.indexOf("Fate 3")).toBeLessThan(text.indexOf("You pick the lock"));
  });

  it("marks a turn that stuttered and says what the engine did", async () => {
    const io = scriptedIO(["one", "two"]);
    const api = fakeRuntimeApi({ outcomeFor: (t) => (t === 2 ? "repaired" : "ok") });
    await runPlay({ api, config: makeConfig("light"), store: new MemoryStore(), llm: new MockProvider(), saveId: "p", io });
    const text = io.out.join("");
    expect(text).toContain("[turn 2 needed a repair: delta_repair]");
    expect(text).not.toContain("turn 1 needed");
  });

  it("passes the raw-logging choice to the runtime only when asked", async () => {
    const api = fakeRuntimeApi();
    await runPlay({ api, config: makeConfig("light"), store: new MemoryStore(), llm: new MockProvider(), saveId: "p", io: scriptedIO([]) });
    expect((api.created[0] as { logRaw?: boolean }).logRaw).toBeUndefined();

    const api2 = fakeRuntimeApi();
    await runPlay({ api: api2, config: makeConfig("light"), store: new MemoryStore(), llm: new MockProvider(), saveId: "q", io: scriptedIO([]), logRaw: true });
    expect((api2.created[0] as { logRaw?: boolean }).logRaw).toBe(true);
  });

  it("hides the panel for non-tabletop profiles, handles /debug and /quit", async () => {
    const io = scriptedIO(["go", "/debug", "/debug", "/quit", "never reached"]);
    const api = fakeRuntimeApi();
    await runPlay({ api, config: makeConfig("light"), store: new MemoryStore(), llm: new MockProvider(), saveId: "p", io });
    const text = io.out.join("");
    expect(text).not.toContain("Money: 10");
    expect(text).toContain("debug on");
    expect(text).toContain("context parts:");
    expect(text).toContain("debug off");
    expect(api.calls).toEqual(["go"]);
  });

  it("joins lines ending with a backslash into one turn", async () => {
    const io = scriptedIO(["first action \\", "second action", "/quit"]);
    const api = fakeRuntimeApi();
    await runPlay({ api, config: makeConfig("light"), store: new MemoryStore(), llm: new MockProvider(), saveId: "p", io });
    expect(api.calls).toEqual(["first action\nsecond action"]);
  });

  it("resumes an existing save and uses dim codes when color is on", async () => {
    const store = new MemoryStore();
    const api = fakeRuntimeApi();
    await runPlay({ api, config: makeConfig(), store, llm: new MockProvider(), saveId: "p", io: scriptedIO([]) });
    const io = scriptedIO(["x"]);
    io.color = true;
    await runPlay({ api, config: makeConfig(), store, llm: new MockProvider(), saveId: "p", io });
    const text = io.out.join("");
    expect(text).toContain("Resumed");
    expect(text).toContain("\x1b[2m");
  });
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "book-harness-"));
  const config = join(dir, "config.json");
  const fx = join(dir, "fx.json");
  const probes = join(dir, "probes.json");
  await writeFile(config, JSON.stringify(makeConfig()));
  await writeFile(fx, JSON.stringify({ id: "fx", inputs: Array.from({ length: 6 }, (_, i) => ({ turn: i + 1, text: `go ${i + 1}` })) }));
  await writeFile(probes, JSON.stringify([{ after_turn: 3, question: "What did I do?", expect_any: ["what did i do"] }]));
  return { dir, config, fx, probes };
}

describe("runCli", () => {
  it("replay writes a report, baseline writes another, report compares them", async () => {
    const s = await setup();
    const out: string[] = [];
    const deps = { out: (t: string) => out.push(t), err: (t: string) => out.push(`ERR ${t}`), dataRoot: join(s.dir, "data"), env: {}, loadRuntime: async () => fakeRuntimeApi() };
    const reports = join(s.dir, "reports");
    expect(await runCli(["replay", "--config", s.config, "--fixture", s.fx, "--probes", s.probes, "--out", reports, "--save", "r1"], deps)).toBe(0);
    expect(await runCli(["baseline", "--config", s.config, "--fixture", s.fx, "--probes", s.probes, "--out", reports], deps)).toBe(0);
    expect((await readdir(reports)).sort()).toEqual(["baseline-fx-mock.json", "replay-fx-mock.json"]);
    const engine = JSON.parse(await readFile(join(reports, "replay-fx-mock.json"), "utf8"));
    expect(engine.kind).toBe("engine");
    expect(engine.turns).toHaveLength(6);
    expect(engine.probes[0].passed).toBe(true);
    out.length = 0;
    expect(await runCli(["report", join(reports, "replay-fx-mock.json"), join(reports, "baseline-fx-mock.json")], deps)).toBe(0);
    expect(out.join("\n")).toContain("cumulative input tokens");
    out.length = 0;
    expect(await runCli(["report", join(reports, "baseline-fx-mock.json")], deps)).toBe(0);
    expect(out.join("\n")).toContain("baseline report");
  });

  it("refuses real-model runs without caps and never loads the runtime", async () => {
    const s = await setup();
    const out: string[] = [];
    let loaded = false;
    const deps = { out: () => {}, err: (t: string) => out.push(t), dataRoot: s.dir, env: { ANTHROPIC_API_KEY: "k" }, loadRuntime: async () => { loaded = true; return fakeRuntimeApi(); } };
    expect(await runCli(["replay", "--config", s.config, "--fixture", s.fx, "--provider", "anthropic"], deps)).toBe(1);
    expect(out.join("")).toMatch(/without a cap/);
    expect(await runCli(["baseline", "--config", s.config, "--fixture", s.fx, "--provider", "anthropic"], deps)).toBe(1);
    expect(loaded).toBe(false);
  });

  it("reports bad usage with exit code 1", async () => {
    const errs: string[] = [];
    const deps = { out: () => {}, err: (t: string) => errs.push(t), env: {} };
    expect(await runCli([], deps)).toBe(1);
    expect(await runCli(["nope"], deps)).toBe(1);
    expect(await runCli(["replay"], deps)).toBe(1);
    expect(errs.join("\n")).toMatch(/--config is required/);
    expect(await runCli(["report", "/does/not/exist.json"], deps)).toBe(1);
  });

  it("honours --max-turns and --faults on replay", async () => {
    const s = await setup();
    const deps = { out: () => {}, err: () => {}, dataRoot: join(s.dir, "d"), env: {}, loadRuntime: async () => fakeRuntimeApi() };
    const out = join(s.dir, "o");
    expect(await runCli(["replay", "--config", s.config, "--fixture", s.fx, "--max-turns", "2", "--faults", "every=1,kind=fixable", "--out", out], deps)).toBe(0);
    const r = JSON.parse(await readFile(join(out, "replay-fx-mock.json"), "utf8"));
    expect(r.turns).toHaveLength(2);
    expect(r.stopped_reason).toMatch(/max-turns/);
  });
});
