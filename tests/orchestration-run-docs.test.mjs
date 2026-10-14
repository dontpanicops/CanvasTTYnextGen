// The run's plan and result documents (docs/agent-orchestration/implementation/plan-result-docs.md): derived from the
// journal, never invented; the text of a created document read back from its diff; the same document as markdown.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addedText, pickDocs, toMarkdown, noteText, NOTE_MAX, planDoc, resultDoc, stageTask } from "../src/renderer/src/features/orchestration/runDocs.ts";

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

const COND = {
  requirements: [
    { id: "R1", text: "Проект проанализирован", conditions: ["C1"], status: "met" },
    { id: "R2", text: "Логика понятна", conditions: ["C2"], status: "dropped", why: "лишнее" }],
  conditions: [
    { id: "C1", text: "разбор записан", covers: ["R1"], stage: 1, status: "met", evidence: { kind: "change" }, proof: null },
    { id: "C2", text: "тесты проходят", covers: ["R2"], stage: 2, status: "not_checked", evidence: { kind: "check", check: "cmd-1", command: "node --test" }, proof: null }],
  dropped: [{ id: "C3", text: "старое условие", covers: ["R2"], why: "заменено" }], met: 1, total: 2 };
const stage = (n, state, over = {}) => ({ n, plan: 1, title: `Этап-${n}`, state, rounds: 1, verdict: null, report: null, findings: null, ...over });
const model = (over = {}) => ({ goal: null, stages: [stage(1, "done"), stage(2, "not_started")], superseded: [], stageCounts: { done: 1, total: 2 },
  checks: [], checkCounts: { passed: 0, total: 0 }, checksKnown: true, reviews: [], currentReview: null, openQuestion: null, finalVerdict: null,
  finalReport: null, finalFindings: null, lastReport: null, finish: null, checkpoint: null, endedAt: null, complete: true, ...over });
const view = (over = {}) => ({ runId: "abcdef1234567890", status: "running", reason: null, workMode: "copy",
  progress: { conditions: COND, findings: null, checks: [], finish: [], completion: null }, ...over });
const plan1 = { version: 1, firstStage: 1, text: { stages: [{ title: "Этап-1", task: "Записать разбор" }, { title: "Этап-2", task: "Проверить" }], question: null } };
const input = (over = {}) => ({ view: view(), model: model(), task: { key: "T-1", title: "Разбор" }, goal: { text: "Разобрать бизнес-логику" },
  plans: [plan1], report: () => "loading", take: null, asOf: "2026-10-11T09:49:00.000Z", ...over });
const lines = (doc) => doc.sections.flatMap((s) => [s.heading, ...s.lines.map((l) => l.text ?? l.path)]);

test("planDoc: goal, requirements, every stage with its task and conditions, how each is proved", () => {
  const doc = planDoc(input(), "ru");
  assert.equal(doc.title, "T-1 · Разбор — план");
  const all = lines(doc);
  assert.ok(all.includes("Разобрать бизнес-логику"));
  assert.ok(all.includes("R1 Проект проанализирован"));
  assert.ok(all.some((l) => l.startsWith("R2 Логика понятна — снято: лишнее")));
  assert.ok(all.some((l) => l.startsWith("Этап 1: Этап-1 — ")));
  assert.ok(all.includes("Записать разбор") && all.includes("Проверить"));
  assert.ok(all.includes("C1 разбор записан — изменение в файлах; закрывает R1"));
  assert.ok(all.includes("C2 тесты проходят — проверка `node --test`; закрывает R2"));
  const rq = doc.sections.find((s) => s.heading === "Требования");
  assert.deepEqual(rq.lines.map((l) => l.mark), ["met", "dropped"]);
});

test("planDoc: a replan names its stages from its first stage on; the dropped condition is in a folded section", () => {
  const plan2 = { version: 2, firstStage: 2, text: { stages: [{ title: "Новый-2", task: "Проверить иначе" }], question: "Какой формат?" } };
  assert.equal(stageTask([plan1, plan2], 1), "Записать разбор");
  assert.equal(stageTask([plan1, plan2], 2), "Проверить иначе");
  assert.equal(stageTask([plan1, plan2], 3), null);
  const doc = planDoc(input({ plans: [plan1, plan2] }), "ru");
  const re = doc.sections.find((s) => s.heading === "Перепланирования");
  assert.equal(re.collapsed, true);
  assert.ok(re.lines.some((l) => l.text === "План 2: с этапа 2"));
  assert.ok(re.lines.some((l) => l.text === "C3 старое условие — снято: заменено" && l.mark === "dropped"));
  const q = doc.sections.find((s) => s.heading === "Вопрос лида");
  assert.equal(q.lines[0].text, "Какой формат?");
  assert.equal(q.lines[0].said, "со слов лида");
});

test("planDoc: an unread plan says so, a missing one is not invented", () => {
  const loading = planDoc(input({ plans: [{ version: 1, firstStage: 1, text: "loading" }], goal: "loading" }), "ru");
  assert.equal(lines(loading).filter((l) => l === "загружается…").length, 3); // goal + two stages
  const untitled = planDoc(input({ model: model({ stages: [stage(1, "done", { title: null })] }), plans: [{ version: 1, firstStage: 1, text: "loading" }] }), "ru");
  assert.ok(lines(untitled).includes("Этап 1: загружается… — выполнен — принят лидом"));
  const errored = planDoc(input({ model: model({ stages: [stage(1, "done", { title: null })] }), plans: [{ version: 1, firstStage: 1, text: "error" }] }), "ru");
  assert.ok(lines(errored).some((l) => l.startsWith("Этап 1: не удалось прочитать — ")));
  const p2 = { version: 2, firstStage: 2, text: "loading" };
  assert.equal(stageTask([plan1, p2], 2), "loading");
  assert.equal(stageTask([plan1, p2], 1), "Записать разбор");
  assert.equal(stageTask([{ version: 1, firstStage: 1, text: "error" }], 2), "error");
  const none = planDoc(input({ model: model({ stages: null, stageCounts: null }), plans: [] }), "ru");
  assert.ok(lines(none).includes("Лид ещё составляет план."));
  assert.ok(!lines(none).includes("Этапы, задания и условия — со слов лида."));
  assert.ok(lines(planDoc(input(), "ru")).includes("Этапы, задания и условия — со слов лида."));
});

test("planDoc: a v1 run (no conditions) has stages and no requirements", () => {
  const doc = planDoc(input({ view: view({ progress: { conditions: null, findings: null, checks: [], finish: [], completion: null } }) }), "ru");
  assert.ok(!doc.sections.some((s) => s.heading === "Требования"));
  assert.ok(lines(doc).includes("Записать разбор"));
});

test("planDoc: without a board task the title is the goal's first line", () => {
  assert.equal(planDoc(input({ task: null }), "ru").title, "Разобрать бизнес-логику — план");
  assert.equal(planDoc(input({ task: null, goal: "loading" }), "ru").title, "abcdef12 — план");
});

const report = (summary) => JSON.stringify({ summary, done: true });
const done = (over = {}) => input({
  view: view({ status: "completed", progress: { conditions: COND, findings: { items: [], disputed: [], openBlocking: 0 }, checks: [], finish: [], completion: "no_checks" } }),
  model: model({ stages: [stage(1, "done", { report: { sha256: "r1", bytes: 10 } }), stage(2, "done", { report: null })], finalVerdict: "complete" }),
  report: (sha) => (sha === "r1" ? report("разбор записан в docs/a.md") : "error"), ...over });
const ready = (files, more = 0) => ({ state: "ready", at: "checkpoint", files, more });

test("resultDoc: the outcome line is the summary's own words; no checks is never «confirmed»", () => {
  const doc = resultDoc(done(), ready([]), "ru");
  assert.equal(doc.title, "T-1 · Разбор — результат");
  const head = doc.sections[0];
  assert.equal(head.heading, "Итог");
  assert.equal(head.lines[0].text, "Проверяющий подтвердил цель финальным ревью, но команды проверки не запускались: результат ничем не подтверждён.");
  assert.ok(head.lines.some((l) => l.text === "Открытых блокирующих замечаний: 0."));
});

test("resultDoc: what was done is the executor's word, marked; requirements carry their marks", () => {
  const doc = resultDoc(done(), ready([]), "ru");
  const d = doc.sections.find((s) => s.heading === "Что сделано");
  assert.equal(d.lines[0].text, "Этап-1: разбор записан в docs/a.md");
  assert.equal(d.lines[0].said, "со слов исполнителя");
  assert.equal(d.lines[1].text, "Этап-2: не указано");
  assert.deepEqual(doc.sections.find((s) => s.heading === "Требования").lines.map((l) => l.mark), ["met", "dropped"]);
});

test("resultDoc: created documents — their text, why one has none, the rest counted; skipped when not read", () => {
  const doc = resultDoc(done(), ready([{ path: "docs/a.md", body: "# A\n", why: null }, { path: "docs/big.md", body: null, why: "too_large" }], 2), "ru");
  const s = doc.sections.find((x) => x.heading === "Созданные документы");
  assert.deepEqual(s.lines.slice(0, 2).map((l) => [l.kind, l.path, l.body, l.note]), [
    ["file", "docs/a.md", "# A\n", null], ["file", "docs/big.md", null, "Документ больше 256 КиБ — откройте его во вкладке «Изменения»."]]);
  assert.ok(s.lines.some((l) => l.text === "Ещё 2 — во вкладке «Изменения»."));
  assert.ok(!resultDoc(done(), { state: "skipped" }, "ru").sections.some((x) => x.heading === "Созданные документы"));
  const err = resultDoc(done(), { state: "error", message: "копии нет" }, "ru").sections.find((x) => x.heading === "Созданные документы");
  assert.equal(err.lines[0].text, "Не удалось прочитать изменения: копии нет");
  assert.ok(resultDoc(done(), ready([]), "ru").sections.find((x) => x.heading === "Созданные документы").lines.some((l) => l.text === "Задача не создала документов."));
});

test("resultDoc: how to take it — copy, worktree branch, in place, already taken", () => {
  const take = (doc) => doc.sections.find((s) => s.heading === "Как забрать").lines.map((l) => l.text);
  assert.match(take(resultDoc(done(), ready([]), "ru"))[0], /^Результат в отдельной копии/);
  assert.match(take(resultDoc(done({ view: view({ status: "completed", workMode: "project" }) }), ready([]), "ru"))[0], /^Запуск работал в вашей рабочей папке/);
  assert.match(take(resultDoc(done({ view: view({ status: "completed", workMode: "worktree", progress: { ...view().progress, branch: "canvastty/t-1" } }) }), ready([]), "ru"))[0], /`canvastty\/t-1`/);
  const taken = { mode: "copy", from: "checkpoint", stage: 1, files: 3, allowed: true, suggested: "raoden/x", runBranch: null, branch: { name: "raoden/t-1", at: "2026-10-11T10:00:00Z" }, applied: null };
  assert.ok(take(resultDoc(done({ take: taken }), ready([]), "ru"))[0].includes("raoden/t-1"));
});

test("resultDoc: nothing done yet says so", () => {
  const doc = resultDoc(input({ model: model({ stages: null }) }), { state: "loading" }, "ru");
  assert.equal(doc.sections.find((s) => s.heading === "Что сделано").lines[0].text, "Пока нечего показать.");
  assert.equal(doc.sections.find((s) => s.heading === "Созданные документы").lines[0].text, "загружается…");
});
