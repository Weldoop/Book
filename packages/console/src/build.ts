import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

/**
 * Workspace packages ship TypeScript source. The Vercel function is one bundled
 * JavaScript file so the host does not have to compile those packages.
 */
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../../.vercel/output");
const func = join(out, "functions/api/turn.func");
const resumeFunc = join(out, "functions/api/resume.func");

await rm(out, { recursive: true, force: true });
await mkdir(func, { recursive: true });
await mkdir(join(out, "static"), { recursive: true });

await esbuild.build({
  entryPoints: [join(here, "entry.ts")],
  outfile: join(func, "index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  legalComments: "none",
});

await writeFile(join(func, "package.json"), JSON.stringify({ type: "module" }) + "\n");
await writeFile(
  join(func, ".vc-config.json"),
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.js", maxDuration: 60 }, null, 2) + "\n",
);
await cp(join(here, "page.html"), join(func, "page.html"));
await cp(join(here, "page.html"), join(out, "static/index.html"));
// The host filesystem is read-only. Resume reads this copy; turns do not write it.
try {
  await cp(join(here, "../saves"), join(func, "saves"), { recursive: true });
} catch (err) {
  const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
  if (code !== "ENOENT") throw err;
}
// A rewrite to /api/turn would change the path the handler sees, so resume is its own function.
await cp(func, resumeFunc, { recursive: true });
await writeFile(
  join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "/(.*)", headers: { "cache-control": "no-store" }, continue: true },
        { handle: "filesystem" },
      ],
    },
    null,
    2,
  ) + "\n",
);

process.stdout.write(`console bundle at ${out}\n`);
