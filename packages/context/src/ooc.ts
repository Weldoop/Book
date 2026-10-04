import type { Config, Module, State } from "@book/schema";
import { mapAttention } from "./attention.ts";
import { resolveBudget } from "./budget.ts";
import { focusSection, sceneSection, stateSection, storySection, threadsSection } from "./sections.ts";
import { tokensOf } from "./text.ts";
import { joinSections, sumTokens } from "./turn.ts";
import type { BuiltContext, ContextPart } from "./types.ts";

export const OOC_SYSTEM = [
  "You are the Game Master answering an out-of-character question from the player.",
  "Answer in square brackets, briefly, in plain text (not JSON).",
  "Answer only from the provided state. If it is not there, say you do not know.",
  "Never change the story, never narrate new events, never reveal hidden plot you were not shown.",
].join("\n");

export function stripOocMarkers(input: string): string {
  let s = input.trim();
  s = s.replace(/^ooc\s*[:\-]\s*/i, "");
  const paren = /^\(\s*([\s\S]*?)\s*\)$/.exec(s);
  if (paren?.[1] !== undefined) s = paren[1].replace(/^ooc\s*[:\-]\s*/i, "");
  return s.trim();
}

export interface OocInput {
  config: Config;
  state: State;
  modules: Module[];
  input: string;
}

export function buildOocContext(i: OocInput): BuiltContext {
  const budget = resolveBudget();
  const question = stripOocMarkers(i.input);
  const ids = mapAttention({ ...i, input: question, due: [], limit: 6 });
  const focus = focusSection(i.state, ids, 300);

  const sections = [
    { part: "scene", section: sceneSection(i.config, i.state) },
    { part: "state_snapshot", section: stateSection(i.config, i.state, i.modules, budget.state_snapshot) },
    { part: "threads", section: threadsSection(i.state, budget.threads) },
    { part: "entities_in_focus", section: focus.section },
    { part: "story_so_far", section: storySection(i.state, budget.story_so_far) },
    { part: "input", section: { text: `## QUESTION\n${question}`, trimmed: false } },
  ];
  const parts: ContextPart[] = [
    { name: "contract", tokens: tokensOf(OOC_SYSTEM), trimmed: false },
    ...sections.map(({ part, section }) => ({
      name: part,
      tokens: tokensOf(section.text),
      trimmed: section.trimmed,
    })),
  ];
  return {
    system: [{ text: OOC_SYSTEM, cache: true }],
    messages: [{ role: "user", content: joinSections(sections) }],
    parts,
    total_tokens: sumTokens(parts),
    focus: focus.shown,
  };
}
