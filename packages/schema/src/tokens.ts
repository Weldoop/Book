/** Rough, dependency-free token estimate. Real usage comes from provider responses. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
