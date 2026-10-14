// The run's plan and result documents (docs/agent-orchestration/implementation/plan-result-docs.md): derived from the
// journal, never invented; the text of a created document read back from its diff; the same document as markdown.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addedText, pickDocs, toMarkdown, noteText, NOTE_MAX } from "../src/renderer/src/features/orchestration/runDocs.ts";

const diffOf = (lines) => ({ path: "docs/a.md", truncated: false, text: [
  "diff --git a/docs/a.md b/docs/a.md", "new file mode 100644", "index 0000000..1111111", "--- /dev/null", "+++ b/docs/a.md",
  `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n") + "\n" });

test("addedText: a new file's text from its diff, headers and hunk lines dropped", () => {
  assert.deepEqual(addedText(diffOf(["# Title", "", "text"])), { body: "# Title\n\ntext\n", why: null });
});

test("addedText: lines of the file that look like diff lines stay as they are", () => {
  assert.equal(addedText(diffOf(["+plus", "@@ not a hunk", "\\ backslash", "--- dashes"])).body, "+plus\n@@ not a hunk\n\\ backslash\n--- dashes\n");
});

test("addedText: no newline at the end, CRLF kept", () => {
  const d = diffOf(["a\r", "b"]);
  d.text += "\\ No newline at end of file\n";
  assert.equal(addedText(d).body, "a\r\nb");
});

test("addedText: binary and too large have no text", () => {
  assert.deepEqual(addedText({ path: "x.md", truncated: false, text: "diff --git a/x.md b/x.md\nnew file mode 100644\nBinary files /dev/null and b/x.md differ\n" }), { body: null, why: "binary" });
  assert.deepEqual(addedText({ path: "x.md", truncated: true, text: "" }), { body: null, why: "too_large" });
});

test("pickDocs: added text documents only, ten at most, the rest counted", () => {
  const files = [
    ...Array.from({ length: 12 }, (_, i) => ({ path: `docs/n${i}.md`, status: "added" })),
    { path: "src/a.ts", status: "added" }, { path: "docs/old.md", status: "modified" }, { path: "notes.TXT", status: "added" }, { path: "r.markdown", status: "added" }];
  const got = pickDocs(files);
  assert.equal(got.paths.length, 10);
  assert.ok(got.paths.every((p) => /\.(md|markdown|txt)$/i.test(p)));
  assert.ok(!got.paths.includes("src/a.ts") && !got.paths.includes("docs/old.md"));
  assert.equal(got.more, 4);
});

const DOC = { title: "T-1 · Разбор — результат", asOf: "по состоянию на 12:49", sections: [
  { heading: "Итог", lines: [{ kind: "text", text: "Готово." }] },
  { heading: "Требования", lines: [{ kind: "item", text: "R1 Проект разобран", mark: "met" }, { kind: "item", text: "R2 Понятно", mark: "not_met" }] },
  { heading: "Что сделано", lines: [{ kind: "text", text: "Этап 1: разбор записан", said: "со слов исполнителя" }] },
  { heading: "Созданные документы", lines: [{ kind: "file", path: "docs/a.md", body: "# A\n\ntext\n", note: null }, { kind: "file", path: "docs/b.md", body: null, note: "Не текстовый файл." }] }] };

test("toMarkdown: headings, lists with marks, the agent's word marked, no HTML", () => {
  const md = toMarkdown(DOC);
  assert.ok(md.startsWith("# T-1 · Разбор — результат\n\nпо состоянию на 12:49\n"));
  assert.match(md, /\n## Требования\n\n- ✓ R1 Проект разобран\n- ✗ R2 Понятно\n/);
  assert.match(md, /Этап 1: разбор записан _\(со слов исполнителя\)_/);
  assert.match(md, /\n### docs\/a\.md\n\n# A\n\ntext\n/);
  assert.match(md, /\n### docs\/b\.md\n\nНе текстовый файл\./);
  assert.ok(!/<[a-z]/i.test(md));
  assert.ok(md.endsWith("\n"));
});

test("toMarkdown: a file with both text and a note says the note before the text", () => {
  const md = toMarkdown({ title: "T", asOf: "a", sections: [{ heading: "Д", lines: [{ kind: "file", path: "docs/r.md", body: "# R\n", note: "Восстановлено из изменений." }] }] });
  assert.match(md, /\n### docs\/r\.md\n\n_Восстановлено из изменений\._\n\n# R\n$/);
});

test("noteText: a long document is cut with a closing line", () => {
  assert.equal(noteText("short", "cut"), "short");
  const long = "x".repeat(NOTE_MAX + 5);
  const got = noteText(long, "… обрезано");
  assert.equal(got.length, NOTE_MAX);
  assert.ok(got.endsWith("\n\n… обрезано\n"));
});
