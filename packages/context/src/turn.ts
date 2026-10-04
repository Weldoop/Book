import type { Config, DueItem, LLMSystemBlock, Module, State } from "@book/schema";
import { mapAttention } from "./attention.ts";
import { type ContextBudget, resolveBudget } from "./budget.ts";
import { buildStaticBlocks } from "./contract.ts";
import {
  beatsSection,
  dueSection,
  focusSection,
  inputSection,
  notesSection,
  sceneSection,
  stateSection,
  storySection,
  threadsSection,
  windowSection,
  type Section,
} from "./sections.ts";
import { tokensOf } from "./text.ts";
import { worldSheetSection } from "./world.ts";
import type { BuiltContext, ContextPart, OutputOrder } from "./types.ts";

export interface BuildContextInput {
  config: Config;
  state: State;
  modules: Module[];
  input: string;
  kind: "act" | "continue";
  due: DueItem[];
  fate?: number;
  budget?: Partial<ContextBudget>;
  outputOrder?: OutputOrder;
}

export interface TurnAssembly {
  system: LLMSystemBlock[];
  /** Message sections in order, each with its part name. */
  sections: { part: string; section: Section }[];
  parts: ContextPart[];
  focus: string[];
  threads_shown: string[];
}

export function assembleTurn(i: BuildContextInput): TurnAssembly {
  const budget = resolveBudget(i.budget);
  const order = i.outputOrder ?? "narration_first";
  const stat = buildStaticBlocks(i.config, i.modules, order, budget.module_fragments);

  const focusIds = mapAttention({
    config: i.config,
    state: i.state,
    modules: i.modules,
    input: i.input,
    due: i.due,
  });
  const focus = focusSection(i.state, focusIds, budget.entities_in_focus);

  const threads = threadsSection(i.state, i.config, i.input, budget.threads);
  const sections: { part: string; section: Section }[] = [
    { part: "scene", section: sceneSection(i.config, i.state) },
    { part: "state_snapshot", section: stateSection(i.config, i.state, i.modules, budget.state_snapshot) },
    { part: "due_events", section: dueSection(i.config, i.due, i.fate, budget.due_events) },
    { part: "threads", section: threads },
    { part: "notes", section: notesSection(i.state, i.config, budget.notes) },
    { part: "world_sheet", section: worldSheetSection(i.config, i.state, budget.world_sheet) },
    { part: "entities_in_focus", section: focus.section },
    { part: "story_so_far", section: storySection(i.state, budget.story_so_far) },
    { part: "beats", section: beatsSection(i.state, budget.beats) },
    { part: "window", section: windowSection(i.state, budget.window) },
    { part: "input", section: inputSection(i.input, i.kind) },
  ];

  const parts: ContextPart[] = [
    { name: "contract", tokens: tokensOf(stat.contract), trimmed: false },
    { name: "module_fragments", tokens: tokensOf(stat.fragments), trimmed: stat.fragmentsTrimmed },
    ...sections.map(({ part, section }) => ({
      name: part,
      tokens: tokensOf(section.text),
      trimmed: section.trimmed,
    })),
  ];
  return { system: stat.system, sections, parts, focus: focus.shown, threads_shown: threads.shown };
}

export function joinSections(sections: { section: Section }[]): string {
  return sections
    .map((s) => s.section.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
}

export function sumTokens(parts: ContextPart[]): number {
  return parts.reduce((n, p) => n + p.tokens, 0);
}

export function buildTurnContext(input: BuildContextInput): BuiltContext {
  const a = assembleTurn(input);
  return {
    system: a.system,
    messages: [{ role: "user", content: joinSections(a.sections) }],
    parts: a.parts,
    total_tokens: sumTokens(a.parts),
    focus: a.focus,
    threads_shown: a.threads_shown,
  };
}
