import type { LLMSystemBlock } from "@book/schema";

export interface ContextPart {
  name: string;
  tokens: number;
  trimmed: boolean;
}

export interface ContextMessage {
  role: "user" | "assistant";
  content: string;
}

export interface BuiltContext {
  system: LLMSystemBlock[];
  messages: ContextMessage[];
  parts: ContextPart[];
  total_tokens: number;
  /** Entity ids actually rendered in FOCUS ENTITIES. */
  focus: string[];
  /** Thread ids actually rendered in OPEN THREADS, so reminders can be counted. */
  threads_shown?: string[];
}

export type OutputOrder = "narration_first" | "delta_first";
