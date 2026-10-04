import { createInterface } from "node:readline";

/** Reads a secret from the terminal without echoing it, so it never lands in scrollback or terminal logs. */
export function promptSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("Cannot prompt for the API key: no interactive terminal. Set ANTHROPIC_API_KEY as a secret instead."));
      return;
    }
    process.stdout.write(prompt);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}
