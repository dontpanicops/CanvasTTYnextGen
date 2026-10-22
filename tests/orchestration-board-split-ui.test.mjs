// E4 (docs/agent-orchestration/implementation/stage-e-decomposition.md §2.1, §10): the interface of splitting, without a
// window — the parent's line and actions by each row of §2.1, a parent's subtasks and a subtask's marks, the notes
// (split: once, only recorded when first seen, the lead's question, the badge), the plan tab's proposal, the texts.
import assert from "node:assert/strict";
import test from "node:test";
import { splitActions, splitWhy, subtaskInfo, taskLine, unsplit } from "../src/renderer/src/features/orchestration/boardModel.ts";
import { DEFAULT_NOTIFY_PREFS, splitNotes } from "../src/renderer/src/features/orchestration/notify.ts";
import { planDoc } from "../src/renderer/src/features/orchestration/runDocs.ts";
import { t } from "../src/renderer/src/lib/i18n.ts";
import { boardStatuses } from "../src/shared/taskBoard.ts";

const task = (id, over = {}) => ({ id, key: `T-${id}`, workspaceId: "common", project: "/x/app", title: id, text: "x", criteria: ["a", "b"], dependsOn: [], order: Number(id),
  createdAt: "", updatedAt: "", archivedAt: null, accepted: null, ...over });
const split = (runId, over = {}) => ({ runId, taskId: null, taskKey: null, createdAt: 1, workspaceId: "common", status: "running", reason: null, newer: false, halted: false, limit: null,
  completion: null, phase: "work", permission: false, workMode: null, taken: null, decompositionOf: "1", ...over });
const rowOf = (facts, parent = {}, more = []) => {
  const tasks = [task("1", { decompose: true, ...parent }), ...more];
  const st = boardStatuses({ tasks }, facts).get("1");
  return { tasks, st, parent: tasks[0] };
};
const line = (locale, st, fact = null) => taskLine(locale, st, null, null, fact?.providerLimit ?? null);

const ROWS = [
  ["no split yet", [], { reason: null, column: "queue" }, ["run"], null],
  ["being split", [split("r")], { reason: "decomposing", column: "work" }, ["open"], /разбивается на подзадачи/],
  ["the lead asks", [split("r", { status: "paused", reason: "awaiting_answer" })], { reason: "waits_answer", column: "work" }, ["answer"], /Ждёт ответа/],
  ["paused for another reason", [split("r", { status: "paused", reason: "invalid_report" })], { reason: "decomposition_paused", column: "work" }, ["open"], /разбиение на паузе: .+/],
  ["proposed, subtasks not made yet", [split("r", { status: "completed", split: "proposed" })], { reason: "decomposing", column: "work" }, ["open"], /разбивается/],
  ["whole", [split("r", { status: "completed", split: "whole" })], { reason: null, column: "queue" }, ["open"], /^не разбита$/],
  ["rejected", [split("r", { status: "completed", split: "rejected" })], { reason: "decomposition_failed", column: "review" }, ["again", "whole", "open"], /предложение лида дважды не прошло проверку/],
  ["failed", [split("r", { status: "failed" })], { reason: "decomposition_failed", column: "review" }, ["again", "whole", "open"], /запуск упал/],
  ["stopped", [split("r", { status: "stopped" })], { reason: "decomposition_failed", column: "review" }, ["again", "whole", "open"], /запуск остановлен/],
  ["cannot make the subtasks (§5.1)", [split("r", { status: "completed", split: "proposed", splitFailed: "parent_started" })], { reason: "decomposition_failed", column: "review" }, ["again", "whole", "open"], /у задачи уже был свой запуск/]
];
test("the parent's card by each row of §2.1: the column, the words and the actions", () => {
  for (const [name, facts, want, actions, words] of ROWS) {
    const { st, parent } = rowOf(facts);
    assert.deepEqual([st.reason, st.column], [want.reason, want.column], name);
    assert.deepEqual(splitActions(parent, st), actions, name);
    if (words) assert.match(line("ru", st), words, name);
  }
  // the subtasks gone: «Split again», «Do it whole», no run to open
  const gone = rowOf([], { decomposedBy: "old" });
  assert.equal(gone.st.reason, "subtasks_gone");
  assert.deepEqual(splitActions(gone.parent, gone.st), ["again", "whole"]);
  assert.equal(line("ru", gone.st), "подзадачи удалены или в архиве");
  // a subtask lives: an ordinary task waiting for it — no split actions
  const sub = task("2", { parentId: "1", covers: ["R1"] });
  const live = rowOf([], { decomposedBy: "old", dependsOn: ["2"] }, [sub]);
  assert.deepEqual(splitActions(live.parent, live.st), []);
  // waiting for its own dependencies: nothing to press yet; a subtask and an unmarked task have none
  const waits = rowOf([], { dependsOn: ["3"] }, [task("3")]);
  assert.deepEqual(splitActions(waits.parent, waits.st), []);
  // F3: at a remote base «Do it whole» shows while a dependency waits; without it, as before
  assert.deepEqual(splitActions(waits.parent, waits.st, true), ["whole"]);
  assert.deepEqual(splitActions(waits.parent, waits.st, false), []);
  assert.deepEqual(splitActions({ decompose: undefined }, waits.st), []);
  assert.deepEqual(splitActions({ decompose: true, parentId: "1" }, waits.st), []);
  assert.deepEqual([unsplit(task("1", { decompose: true }), {}), unsplit(task("1", { decompose: true }), { split: { runId: "r", detail: "whole" } }), unsplit(task("1", { decompose: true, decomposedBy: "r" }), {})], [true, false, false]);
});

test("the split's words in English; an unknown detail is shown raw; a provider's limit and a pause reason are named", () => {
  const failed = rowOf([split("r", { status: "completed", split: "rejected" })]).st;
  assert.equal(line("en", failed), "the split failed: the lead's proposal failed the check twice");
  assert.equal(splitWhy("en", "no_such_code"), "no_such_code");
  const paused = rowOf([split("r", { status: "paused", reason: "invalid_report" })]).st;
  assert.doesNotMatch(line("en", paused), /\{|invalid_report/);
  const limited = split("r", { status: "paused", reason: "environment_error", providerLimit: { provider: "claude", resetsAt: Date.UTC(2026, 9, 20, 15, 0) } });
  assert.match(line("ru", rowOf([limited]).st, limited), /Claude|claude/);
  assert.equal(line("en", rowOf([split("r", { status: "completed", split: "whole" })]).st), "not split");
});

test("a parent's subtasks: k of n in the board's result, the archived ones, the requirements changed after the split", () => {
  const s = (id, over = {}) => task(id, { parentId: "1", covers: ["R1"], ...over });
  const run = (id, over = {}) => ({ ...split(id, { decompositionOf: null, taskId: id, status: "completed", completion: "confirmed", workMode: "copy" }), ...over });
  const tasks = [task("1", { decompose: true, decomposedBy: "r", criteria: ["a", "b"], dependsOn: ["2", "3", "4"] }), s("2", { covers: ["R1"] }), s("3", { covers: ["R2"] }), s("4", { covers: ["R2"], archivedAt: "x" })];
  const facts = [run("2"), run("3", { workMode: "project" })];
  const statuses = boardStatuses({ tasks }, facts);
  const merged = { workspaceId: "common", project: "/x/app", ref: "b", n: 1, commit: "c", behind: null, branch: null,
    merges: [{ runId: "m", task: { id: "2", key: "T-2", runId: "2", commit: "c" }, status: "completed", reason: null, completion: "confirmed", createdAt: 1 }] };
  const info = subtaskInfo(tasks[0], tasks, statuses, facts, [merged]);
  // T-2 (a copy) is merged, T-3 (the project folder) is done; the archived T-4 is not counted
  assert.deepEqual([info.live.length, info.done, info.archived.map((x) => x.key), info.criteriaChanged], [2, 2, ["T-4"], false]);
  assert.equal(subtaskInfo(tasks[0], tasks, statuses, facts, []).done, 1, "a copy not merged is not in the result");
  assert.equal(subtaskInfo({ ...tasks[0], criteria: ["a", "b", "c"] }, tasks, statuses, facts, [merged]).criteriaChanged, true);
  assert.equal(subtaskInfo(tasks[1], tasks, statuses, facts, []), null);
});

const place = (p) => p.split("/").at(-1);
const notes = (facts, notified, prefs = DEFAULT_NOTIFY_PREFS, focused = false, parent = {}) =>
  splitNotes("ru", { tasks: [task("1", { decompose: true, ...parent })] }, facts, [], notified, prefs, focused, place);
const FAILED = [split("r1", { status: "failed" })];
const ASKS = [split("r1", { status: "paused", reason: "awaiting_answer" })];

test("«Разбиение T-1 не удалось»: once per run; the first appearance is only recorded, so a restart repeats nothing", () => {
  const first = notes(FAILED, {});
  assert.deepEqual([first.notes.length, first.notified["split:r1"], first.waiting], [0, "failed", 1], "first seen: recorded, on the badge");
  const before = notes([split("r1")], {});
  const told = notes(FAILED, before.notified);
  assert.deepEqual(told.notes.map((n) => [n.runId, n.signal, n.title, n.body]), [["r1", "failed", "app", "Разбиение T-1 не удалось"]]);
  assert.equal(notes(FAILED, told.notified).notes.length, 0, "the same again (a restart reads the record)");
  // «Split again» is a new run: told for it
  const again = notes([...FAILED, split("r2", { createdAt: 2, status: "completed", split: "rejected" })], told.notified);
  assert.equal(again.notes.length, 0, "r2 first seen: recorded");
  const next = notes([...FAILED, split("r2", { createdAt: 2, status: "running" })], again.notified);
  const failed2 = notes([...FAILED, split("r2", { createdAt: 2, status: "failed" })], next.notified);
  assert.deepEqual(failed2.notes.map((n) => n.runId), ["r2"]);
  // the window in focus, or «Доска» off: recorded, not told
  assert.equal(notes(FAILED, before.notified, DEFAULT_NOTIFY_PREFS, true).notes.length, 0);
  assert.equal(notes(FAILED, before.notified, { ...DEFAULT_NOTIFY_PREFS, board: false }).notes.length, 0);
});

test("the lead's question: the «waiting for an answer» note; the badge counts question, failed and paused splits", () => {
  const before = notes([split("r1")], {});
  const asked = notes(ASKS, before.notified);
  assert.deepEqual(asked.notes.map((n) => [n.runId, n.signal, n.body]), [["r1", "waiting", "Лид спрашивает: разбиение T-1"]]);
  assert.equal(notes(ASKS, asked.notified).notes.length, 0, "once");
  assert.deepEqual([asked.waiting, notes(FAILED, {}).waiting, notes([split("r1", { status: "paused", reason: "invalid_report" })], {}).waiting, notes([split("r1")], {}).waiting], [1, 1, 1, 0]);
  // the answer given: the run goes on, the record is cleared, a new question is told again
  const answered = notes([split("r1")], asked.notified);
  assert.equal(answered.notified["split:r1"], "");
  assert.equal(notes(ASKS, answered.notified).notes.length, 1);
  // a split that made its subtasks, or a task not marked, tells nothing
  assert.equal(notes(FAILED, before.notified, DEFAULT_NOTIFY_PREFS, false, { decompose: undefined }).waiting, 0);
});

test("the plan tab shows the proposal (title, dependencies, covered R), the refusal's reasons and the lead's «whole»", () => {
  const view = { runId: "abc", progress: null };
  const model = { stages: null };
  const input = (splitEntries) => ({ view, model, task: { key: "T-1", title: "A" }, goal: { text: "g" }, plans: [], take: null, asOf: "2026-10-20T10:00:00Z", report: () => "error", split: splitEntries });
  const proposal = JSON.stringify({ tasks: [{ id: "S1", title: "Модуль", dependsOn: [], covers: ["R1"] }, { id: "S2", title: "Тесты", dependsOn: ["S1"], covers: ["R2", "R3"] }] });
  const doc = planDoc(input([{ kind: "rejected", text: JSON.stringify(["requirements not covered by any subtask: R3"]) }, { kind: "proposed", text: proposal }]), "ru");
  const texts = doc.sections.flatMap((s) => [s.heading, ...s.lines.map((l) => l.text ?? "")]);
  assert.ok(texts.includes("S1 Модуль — зависит от: —; закрывает: R1"), JSON.stringify(texts));
  assert.ok(texts.includes("S2 Тесты — зависит от: S1; закрывает: R2, R3"));
  assert.ok(texts.includes("requirements not covered by any subtask: R3"));
  assert.ok(!texts.includes(t("ru", "docStagesPending")), "no stages placeholder for a split");
  const whole = planDoc(input([{ kind: "whole", text: "одна правка" }]), "en");
  assert.ok(whole.sections.some((s) => s.heading === "The lead: do it whole" && s.lines[0].text === "одна правка"));
  assert.ok(planDoc(input([{ kind: "proposed", text: "loading" }]), "en").sections.length > 0);
});

test("every key of §10 is worded in both languages", () => {
  const keys = ["boardDecompose", "boardDecomposeRun", "boardDecomposeAgain", "boardDecomposeWhole", "boardDecomposeOpen", "boardReason_decomposing", "boardReason_decomposition_paused",
    "boardReason_decomposition_failed", "boardReason_subtasks_gone", "boardNotSplit", "boardSubtasks", "boardPartOf", "boardCovers", "boardSubtaskArchived", "boardParentArchived",
    "boardCriteriaChanged", "boardApDecomposing", "boardApStop_decomposition_failed", "boardNoteSplitFailed", "boardNoteSplitQuestion", "orchError_has_subtasks",
    "orchError_decomposition_active", "orchError_deps_not_ready", "orchError_no_link", "orchError_text_too_long",
    ...["rejected", "failed", "stopped", "parent_started", "has_subtasks", "parent_gone", "board_unreadable", "too_many_tasks", "requirements_changed", "not_marked"].map((c) => `boardDecomposeWhy_${c}`)];
  for (const locale of ["ru", "en"]) for (const k of keys) assert.ok(t(locale, k), `${locale} ${k}`);
  assert.equal(t("ru", "boardSubtasks").replace("{done}", "3").replace("{n}", "5"), "подзадачи: 3 из 5 в итоге доски");
  assert.equal(t("en", "boardCovers"), "covers {ids} of {key}");
});
