import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire, Module } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const require = createRequire(path.join(ROOT, "package.json"));

async function loadUseCopy() {
  const out = await require("esbuild").build({
    entryPoints: [path.join(ROOT, "src/renderer/src/lib/useCopy.ts")],
    bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent", external: ["react"]
  });
  const file = path.join(ROOT, "use-copy.cjs");
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(ROOT);
  mod._compile(out.outputFiles[0].text, file);
  return mod.exports;
}

const withClipboard = (writeText) => { globalThis.window = { canvasTTY: { clipboard: { writeText } } }; };

test("a copy is «copied» only when the clipboard answers true", async () => {
  const { copyText } = await loadUseCopy();
  withClipboard(async () => true);
  assert.equal(await copyText("x"), "copied");
  withClipboard(async () => false);
  assert.equal(await copyText("x"), "failed");
  withClipboard(async () => { throw new Error("clipboard is busy"); });
  assert.equal(await copyText("x"), "failed");
  withClipboard(() => { throw new Error("no bridge"); });
  assert.equal(await copyText("x"), "failed");
  delete globalThis.window;
});

test("a failed copy says «Не удалось скопировать» / «Could not copy»", async () => {
  const { copyKey } = await loadUseCopy();
  assert.equal(copyKey("failed", "docCopy", "docCopied"), "copyFailed");
  assert.equal(copyKey("copied", "docCopy", "docCopied"), "docCopied");
  assert.equal(copyKey("idle", "docCopy", "docCopied"), "docCopy");
  const i18n = readFileSync(path.join(ROOT, "src/renderer/src/lib/i18n.ts"), "utf8");
  assert.match(i18n, /copyFailed: "Не удалось скопировать"/);
  assert.match(i18n, /copyFailed: "Could not copy"/);
});

// Every place that says «copied» gets its words from copyKey over useCopy, so a failed copy says so everywhere.
test("every «copied» label goes through useCopy and copyKey", () => {
  const files = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p); } };
  walk(path.join(ROOT, "src/renderer/src"));
  const copiedKeys = /"(docCopied|githubAuthCopied)"/g;
  const places = [];
  for (const file of files) {
    if (file.endsWith("i18n.ts")) continue;
    const source = readFileSync(file, "utf8");
    const uses = [...source.matchAll(copiedKeys)];
    if (!uses.length) continue;
    places.push(path.relative(ROOT, file));
    assert.match(source, /= useCopy\(/, file);
    for (const use of uses) {
      const line = source.slice(source.lastIndexOf("\n", use.index) + 1, source.indexOf("\n", use.index));
      assert.match(line, /copyKey\(/, `${file}: ${line.trim()}`);
    }
    assert.doesNotMatch(source, /clipboard\.writeText/, `${file} writes to the clipboard past useCopy`);
  }
  assert.deepEqual(places.sort(), ["src/renderer/src/features/orchestration/RunPanel.tsx", "src/renderer/src/features/plugins/PluginSettingsSection.tsx"]);
});

test("the main process answers a clipboard write: invoke, read back", () => {
  const main = readFileSync(path.join(ROOT, "src/main/ipc/registerIpc.ts"), "utf8");
  assert.match(main, /handleMain\(IPC\.clipboardWrite,[\s\S]*?clipboard\.readText\(\) === text/);
  const preload = readFileSync(path.join(ROOT, "src/preload/index.ts"), "utf8");
  assert.match(preload, /writeText: \(text: string\) => ipcRenderer\.invoke\(IPC\.clipboardWrite, text\)/);
});
