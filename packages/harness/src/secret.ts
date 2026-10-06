import { createInterface } from "node:readline";

/** Reads a secret from the terminal without echoing it, so it never lands in scrollback or terminal logs. */
export function promptSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("Cannot prompt for the API key: no interactive terminal. Set ANTHROPIC_API_KEY as a secret instead."));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const writable = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = writable._writeToOutput.bind(rl);
    writable._writeToOutput = (s) => {
      if (!muted) original(s);
    };
    rl.once("close", () => reject(new Error("No API key entered.")));
    rl.question(prompt, (answer) => {
      rl.removeAllListeners("close");
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}
