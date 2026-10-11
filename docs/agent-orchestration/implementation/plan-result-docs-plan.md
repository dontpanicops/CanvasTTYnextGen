# План реализации: документы «План» и «Результат» запуска

Выполнение: по задачам по порядку, шаги — чекбоксы `- [ ]`. Каждая задача заканчивается зелёными тестами и коммитом.

**Цель:** две новые вкладки панели запуска — «План» и «Результат». Это короткие документы, которые приложение собирает
из журнала. Их можно скопировать или положить на холст заметкой. Кнопки на карточке задачи доски открывают их сразу.

**Архитектура:** чистые функции в новом `runDocs.ts` строят `RunDoc` (заголовок, разделы, строки). Из `RunDoc` рисуется
React-вид и собирается markdown. Данные берутся из того, что renderer уже получает: `view`, история журнала, тексты через
`orch.loadText`, `api().changes` и `api().diff`. Main, журнал и IPC не меняются.

**Стек:** TypeScript, React, `node --test` (тесты импортируют `.ts` renderer напрямую), Electron smoke через
`scripts/orchestration-app-kit.mjs`.

**Спецификация:** [plan-result-docs.md](plan-result-docs.md), ревизия 2. Читать вместе с этим планом.

## Общие ограничения

- Журнал, main, IPC, `settings.json` (формат) не меняются.
- Агентам ничего нового не поручается. Текст агента всегда помечен «со слов исполнителя» или «со слов лида».
- Непрочитанное — «загружается…», непрочитанное с ошибкой — «не удалось прочитать». Выдумывать нельзя.
- Созданные документы: только `added` с расширением `.md`, `.markdown` или `.txt`. Не больше 10. Diff по одному, лимит
  main 256 КиБ.
- Заметка: не больше 30 000 символов, кладётся в активное пространство, в центр видимой области.
- Строки — на русском и английском (`ru` и `en` в `src/renderer/src/lib/i18n.ts`).
- Нигде в коде, коммитах и текстах не упоминать, кем или чем сделана работа.

## Что проверить отдельно

Эти места тесты ниже закрывают явно. Если при реализации всплывёт ещё что-то, оно добавляется сюда и в тест своей
задачи.

1. **Строка файла, похожая на служебную строку diff** (`+…`, `@@…`, `\…`). Внутри документа она должна попасть в текст
   как есть. Задача 1, тест `addedText`.
2. **Запуск без плана, с непрочитанным планом, с перепланированием.** Документ не падает и не берёт задание этапа из
   чужой версии плана. Задача 2.
3. **Запуск журнала v1** (`conditions: null`). «План» и «Результат» без разделов требований. Задачи 2 и 3.
4. **Копии больше нет** (`api().changes` → ошибка). «Результат» показывает остальное, раздел документов — «не удалось
   прочитать» и «Повторить». Задачи 3 и 4.
5. **Очень длинный документ на холст.** Заметка обрезана до 30 000 символов, `settings.json` не раздувается. Задачи 1
   и 5.

## Файлы

| Файл | Что |
|---|---|
| `src/renderer/src/features/orchestration/runDocs.ts` (новый) | типы `RunDoc`, `planDoc`, `resultDoc`, `toMarkdown`, `noteText`, `addedText`, `pickDocs`, `stageTask` |
| `src/renderer/src/features/orchestration/runStatus.ts` | перенос `REVIEWER_WORDS` и новый `saidKey` |
| `src/renderer/src/features/orchestration/RunPanel.tsx` | `RunDocView`, `RunDocs`, `useCreatedDocs`, вкладки, ссылка «Открыть план», «Открыть результат», проп `onNoteFromText` |
| `src/renderer/src/features/orchestration/useAgentCanvasUi.ts` | `PanelTab` |
| `src/renderer/src/features/orchestration/OrchestrationDialogs.tsx` | проброс `onNoteFromText` в `RunPanel` |
| `src/renderer/src/features/workspace/WorkspaceCanvas.tsx` | `noteFromText`, проп в `OrchestrationOverlays` |
| `src/renderer/src/features/orchestration/BoardCard.tsx` | кнопки «План» и «Результат» |
| `src/renderer/src/lib/i18n.ts` | строки `doc*`, `orchTab_plan`, `orchTab_result`; новый текст `orchSummaryOpen` |
| стили панели (файл, где описан `.orch-summary-view`) | `.orch-doc` |
| `tests/orchestration-run-docs.test.mjs` (новый) | модульные тесты |
| `scripts/smoke-orchestration-ui.mjs`, `scripts/smoke-board-ui.mjs` | проверки в собранном приложении |
| `docs/agent-orchestration/implementation/plan-result-docs.md` | правки по итогам (задача 7) |

---

### Задача 1: основа `runDocs.ts` — типы, `addedText`, `pickDocs`, `toMarkdown`, `noteText`

**Файлы:**
- Создать: `src/renderer/src/features/orchestration/runDocs.ts`
- Создать: `tests/orchestration-run-docs.test.mjs`

**Интерфейсы:**
- Использует: `OrchestrationDiff`, `OrchestrationChanges` из `src/shared/orchestration.ts`.
- Даёт (для задач 2–5):
  - `DocMark`, `DocLine`, `DocSection`, `RunDoc`;
  - `addedText(diff): { body: string | null; why: "too_large" | "binary" | null }`;
  - `pickDocs(files): { paths: string[]; more: number }`, `MAX_DOCS = 10`;
  - `toMarkdown(doc): string`;
  - `noteText(markdown, cut): string`, `NOTE_MAX = 30_000`.

- [ ] **Шаг 1: падающие тесты**

`tests/orchestration-run-docs.test.mjs`:

```js
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

test("noteText: a long document is cut with a closing line", () => {
  assert.equal(noteText("short", "cut"), "short");
  const long = "x".repeat(NOTE_MAX + 5);
  const got = noteText(long, "… обрезано");
  assert.equal(got.length, NOTE_MAX + "\n\n… обрезано\n".length);
  assert.ok(got.endsWith("\n\n… обрезано\n"));
});
```

- [ ] **Шаг 2: убедиться, что тесты падают**

Run: `node --test tests/orchestration-run-docs.test.mjs`
Expected: FAIL — `Cannot find module …/runDocs.ts`.

- [ ] **Шаг 3: реализация**

`src/renderer/src/features/orchestration/runDocs.ts`:

```ts
// The run's plan and result documents (docs/agent-orchestration/implementation/plan-result-docs.md): what the person
// reads in a minute, derived from the journal and the run's view — never stored, nothing in them is the agents' proof.
// One RunDoc feeds both the panel's view and the markdown (copy, a note on the canvas), so the two never differ.
import type { OrchestrationChanges, OrchestrationDiff } from "../../../../shared/orchestration.ts";

export type DocMark = "met" | "not_met" | "not_checked" | "dropped" | "open";
// said: whose word the line is («со слов исполнителя»), already in the person's language
export type DocLine = { kind: "text"; text: string; said?: string }
  | { kind: "item"; text: string; mark?: DocMark }
  | { kind: "file"; path: string; body: string | null; note: string | null }; // note: why there is no body
export interface DocSection { heading: string; collapsed?: boolean; lines: DocLine[] }
export interface RunDoc { title: string; asOf: string; sections: DocSection[] }

// A created document's text, read back from its diff against the run's base (diffTreePath: unified, -U3, 256 KiB):
// everything before the first hunk is headers; a file line is its "+" line without that one "+". Main gives no part of
// a diff over its limit, so a document that large has no text here at all.
export function addedText(diff: OrchestrationDiff): { body: string | null; why: "too_large" | "binary" | null } {
  if (diff.truncated) return { body: null, why: "too_large" };
  const out: string[] = [];
  let inHunk = false;
  let noEol = false;
  for (const line of diff.text.split("\n")) {
    if (!inHunk) {
      if (line.startsWith("Binary files ")) return { body: null, why: "binary" };
      if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("\\")) { noEol = true; continue; }
    if (line.startsWith("+")) out.push(line.slice(1));
  }
  return { body: out.length ? out.join("\n") + (noEol ? "" : "\n") : "", why: null };
}

export const MAX_DOCS = 10;
const DOC_FILE = /\.(md|markdown|txt)$/i;
// The documents a task created: added text files, in the order of the list of changes; ten at most, the rest counted.
export function pickDocs(files: OrchestrationChanges["files"]): { paths: string[]; more: number } {
  const all = files.filter((f) => f.status === "added" && DOC_FILE.test(f.path)).map((f) => f.path);
  return { paths: all.slice(0, MAX_DOCS), more: Math.max(0, all.length - MAX_DOCS) };
}

const MARK: Record<DocMark, string> = { met: "✓", not_met: "✗", not_checked: "…", dropped: "—", open: "•" };
export function toMarkdown(doc: RunDoc): string {
  const out: string[] = [`# ${doc.title}`, "", doc.asOf];
  for (const s of doc.sections) {
    out.push("", `## ${s.heading}`);
    let prev: DocLine["kind"] | null = null;
    for (const l of s.lines) {
      if (l.kind !== "item" || prev !== "item") out.push("");
      if (l.kind === "text") out.push(l.said ? `${l.text} _(${l.said})_` : l.text);
      else if (l.kind === "item") out.push(`- ${l.mark ? `${MARK[l.mark]} ` : ""}${l.text}`);
      else out.push(`### ${l.path}`, "", l.body !== null ? l.body.replace(/\n$/, "") : l.note ?? "");
      prev = l.kind;
    }
  }
  return `${out.join("\n")}\n`;
}

// Notes live in settings.json, written whole on every edit: a snapshot on the canvas is cut to this length.
export const NOTE_MAX = 30_000;
export const noteText = (markdown: string, cut: string): string =>
  markdown.length <= NOTE_MAX ? markdown : `${markdown.slice(0, NOTE_MAX)}\n\n${cut}\n`;
```

- [ ] **Шаг 4: тесты зелёные**

Run: `node --test tests/orchestration-run-docs.test.mjs`
Expected: PASS, 7 тестов.

- [ ] **Шаг 5: коммит**

```bash
git add src/renderer/src/features/orchestration/runDocs.ts tests/orchestration-run-docs.test.mjs
git commit -m "feat(orchestration): run documents — markdown, created files read back from their diff"
```

---

### Задача 2: `planDoc` и строки документов

**Файлы:**
- Изменить: `src/renderer/src/features/orchestration/runStatus.ts` — перенести `REVIEWER_WORDS` из `RunPanel.tsx:105`,
  добавить `saidKey`.
- Изменить: `src/renderer/src/features/orchestration/RunPanel.tsx:105-106, 835` — импорт вместо локального списка.
- Изменить: `src/renderer/src/features/orchestration/runDocs.ts`.
- Изменить: `src/renderer/src/lib/i18n.ts` — блок строк `doc*` в `ru` (после `orchSumStage_unloaded`, строка ~1798) и
  в `en` (после `orchSumStage_unloaded` в `en`).
- Тесты: `tests/orchestration-run-docs.test.mjs`.

**Интерфейсы:**
- Использует: `RunSummaryModel`, `SummaryStage`, `outcomeKey`, `reportParts` (`runStatus.ts`), `byReviewer`
  (`runModel.ts`), `OrchestrationRunView`, `OrchestrationConditions`.
- Даёт:
  - `saidKey(view, key): string`;
  - `Loaded<T> = T | "loading" | "error"`;
  - `PlanEntry { version: number; firstStage: number; text: Loaded<PlanJson> }`;
  - `PlanJson { stages: { title: string; task: string }[]; question: string | null }`;
  - `DocInput { view; model; task; goal: Loaded<{ text: string | null }>; plans: PlanEntry[]; report(sha256: string): Loaded<string>; take: OrchestrationTake | null; asOf: string }`;
  - `stageTask(plans, n): Loaded<string> | null`;
  - `planDoc(input, locale): RunDoc`.

- [ ] **Шаг 1: перенос `REVIEWER_WORDS`**

В `runStatus.ts`, рядом с `outcomeKey`:

```ts
// A3: a run the reviewer reviews says so in these words — the application accepts its stages, the reviewer concludes.
export const REVIEWER_WORDS: readonly string[] = ["orchSumOutcome_completed", "orchSumOutcome_completed_no_checks", "orchSumStages_count",
  "orchSumStages_countPartial", "orchSumStage_done", "orchSumStage_not_done", "orchSumStage_not_checked", "orchSum_lead", "orchSumRemarksNone",
  "orchSumCurrentReview", "orchSumCurrentReviewPartial"];
export const saidKey = (view: OrchestrationRunView | null, key: string): string =>
  (byReviewer(view) && REVIEWER_WORDS.includes(key) ? `${key}_rv` : key);
```

В `RunPanel.tsx` удалить локальный `REVIEWER_WORDS` (строки 105–106), импортировать `saidKey` из `./runStatus.ts`. Строку
835 заменить на `const said = (key: string) => tr(locale, saidKey(view, key));`. `byReviewer` в `runStatus.ts` уже
импортирован из `runModel.ts` (`runStatus.ts`, строка 6). Если нет — добавить в тот же импорт.

Run: `npx tsc --noEmit -p tsconfig.web.json` (или проектный `npm run typecheck`).
Expected: без ошибок.

- [ ] **Шаг 2: строки**

В `ru`:

```ts
  orchTab_plan: "План",
  orchTab_result: "Результат",
  docPlanTitle: "{name} — план",
  docResultTitle: "{name} — результат",
  docAsOf: "по состоянию на {time}",
  docGoal: "Цель",
  docRequirements: "Требования",
  docStagesPending: "Лид ещё составляет план.",
  docStageHeading: "Этап {n}: {title} — {state}",
  docConditions: "Условия готовности:",
  docEvidenceCheck: "проверка `{cmd}`",
  docEvidenceChange: "изменение в файлах",
  docEvidencePerson: "ваше решение",
  docCovers: "закрывает {ids}",
  docDroppedWhy: "снято: {why}",
  docReplans: "Перепланирования",
  docReplanLine: "План {v}: с этапа {stage}",
  docQuestion: "Вопрос лида",
  docByLead: "со слов лида",
  docByExecutor: "со слов исполнителя",
  docLoading: "загружается…",
  docUnreadable: "не удалось прочитать",
  docNotSaid: "не указано",
  docOutcome: "Итог",
  docChecksLine: "Проверки: {passed} из {total} прошли.",
  docBlockingLine: "Открытых блокирующих замечаний: {n}.",
  docSeeSummary: "Подробности — во вкладке «Итог».",
  docDone: "Что сделано",
  docNothingYet: "Пока нечего показать.",
  docDocs: "Созданные документы",
  docDocsNone: "Задача не создала документов.",
  docDocsMore: "Ещё {n} — во вкладке «Изменения».",
  docDocsError: "Не удалось прочитать изменения: {message}",
  docFileTooLarge: "Документ больше 256 КиБ — откройте его во вкладке «Изменения».",
  docFileBinary: "Не текстовый файл.",
  docFileUnavailable: "Не удалось прочитать файл.",
  docTake: "Как забрать",
  docTakeCopy: "Результат в отдельной копии, ваша папка не менялась — заберите его кнопкой «Забрать результат».",
  docTakeWorktree: "Результат в ветке `{branch}`, ваша папка не менялась — заберите его кнопкой «Забрать результат».",
  docTakeInPlace: "Запуск работал в вашей рабочей папке — изменения уже там.",
  docCopy: "Копировать",
  docCopied: "Скопировано",
  docToCanvas: "На холст",
  docNoteCut: "… обрезано — документ целиком во вкладке запуска.",
  docOpenPlan: "Открыть план",
```

В `en` те же ключи:

```ts
  orchTab_plan: "Plan",
  orchTab_result: "Result",
  docPlanTitle: "{name} — plan",
  docResultTitle: "{name} — result",
  docAsOf: "as of {time}",
  docGoal: "Goal",
  docRequirements: "Requirements",
  docStagesPending: "The lead is still making the plan.",
  docStageHeading: "Stage {n}: {title} — {state}",
  docConditions: "Readiness conditions:",
  docEvidenceCheck: "check `{cmd}`",
  docEvidenceChange: "a change in the files",
  docEvidencePerson: "your decision",
  docCovers: "covers {ids}",
  docDroppedWhy: "dropped: {why}",
  docReplans: "Replans",
  docReplanLine: "Plan {v}: from stage {stage}",
  docQuestion: "The lead's question",
  docByLead: "as the lead says",
  docByExecutor: "as the executor says",
  docLoading: "loading…",
  docUnreadable: "could not be read",
  docNotSaid: "not specified",
  docOutcome: "Outcome",
  docChecksLine: "Checks: {passed} of {total} passed.",
  docBlockingLine: "Open blocking findings: {n}.",
  docSeeSummary: "Details are in the «Summary» tab.",
  docDone: "What was done",
  docNothingYet: "Nothing to show yet.",
  docDocs: "Documents created",
  docDocsNone: "The task created no documents.",
  docDocsMore: "{n} more — in the «Changes» tab.",
  docDocsError: "Could not read the changes: {message}",
  docFileTooLarge: "The document is over 256 KiB — open it in the «Changes» tab.",
  docFileBinary: "Not a text file.",
  docFileUnavailable: "Could not read the file.",
  docTake: "How to take it",
  docTakeCopy: "The result is in a separate copy, your folder is unchanged — take it with «Take the result».",
  docTakeWorktree: "The result is in the branch `{branch}`, your folder is unchanged — take it with «Take the result».",
  docTakeInPlace: "The run worked in your working folder — the changes are already there.",
  docCopy: "Copy",
  docCopied: "Copied",
  docToCanvas: "To the canvas",
  docNoteCut: "… cut — the whole document is in the run's tab.",
  docOpenPlan: "Open the plan",
```

Название кнопки «Забрать результат» в `docTakeCopy` и `docTakeWorktree` сверить с `orchTakeOpen` (ru и en) и
подставить точный текст.

- [ ] **Шаг 3: падающие тесты `planDoc`**

Дописать в `tests/orchestration-run-docs.test.mjs`. Импорт расширить:

```js
import { addedText, pickDocs, toMarkdown, noteText, NOTE_MAX, planDoc, stageTask } from "../src/renderer/src/features/orchestration/runDocs.ts";

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
  assert.equal(stageTask([{ version: 1, firstStage: 1, text: "error" }], 2), "error");
  const none = planDoc(input({ model: model({ stages: null, stageCounts: null }), plans: [] }), "ru");
  assert.ok(lines(none).includes("Лид ещё составляет план."));
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
```

Run: `node --test tests/orchestration-run-docs.test.mjs`
Expected: FAIL — `planDoc` не экспортирован.

- [ ] **Шаг 4: реализация `planDoc`**

Дописать в `runDocs.ts`. Импорты в начало файла:

```ts
import type { LocaleId } from "../../../../shared/contracts.ts";
import type { OrchestrationConditions, OrchestrationRunView, OrchestrationTake } from "../../../../shared/orchestration.ts";
import { t, type TranslationKey } from "../../lib/i18n.ts";
import { saidKey, type RunSummaryModel } from "./runStatus.ts";
```

Код:

```ts
export type Loaded<T> = T | "loading" | "error";
export interface PlanJson { stages: { title: string; task: string }[]; question: string | null }
// one recorded plan, in journal order: version 1, 2, …; firstStage — the global number of its first stage
export interface PlanEntry { version: number; firstStage: number; text: Loaded<PlanJson> }
export interface DocInput {
  view: OrchestrationRunView;
  model: RunSummaryModel;
  task: { key: string; title: string } | null;
  goal: Loaded<{ text: string | null }>;
  plans: readonly PlanEntry[];
  report(sha256: string): Loaded<string>; // an executor's report text, read through the shared text cache
  take: OrchestrationTake | null;
  asOf: string; // ISO time the document describes
}

const fill = (s: string, vars: Record<string, string | number>): string =>
  Object.entries(vars).reduce((a, [k, v]) => a.replaceAll(`{${k}}`, String(v)), s);
const w = (locale: LocaleId, key: string, vars: Record<string, string | number> = {}): string => fill(t(locale, key as TranslationKey), vars);
const hhmm = (locale: LocaleId, iso: string): string => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
const loaded = (locale: LocaleId, v: Loaded<string> | null): string =>
  v === "loading" ? w(locale, "docLoading") : v === "error" ? w(locale, "docUnreadable") : v ?? w(locale, "docNotSaid");

function docName(input: DocInput): string {
  if (input.task) return `${input.task.key} · ${input.task.title}`;
  const first = typeof input.goal === "object" && input.goal.text ? input.goal.text.split("\n")[0].trim() : "";
  if (!first) return input.view.runId.slice(0, 8);
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

// A stage's task: the newest plan that names it (a replan names its stages from its firstStage on; a stage before that
// keeps the task of the plan it was done under). An unread plan is said as such, never filled from an older one.
export function stageTask(plans: readonly PlanEntry[], n: number): Loaded<string> | null {
  for (let i = plans.length - 1; i >= 0; i -= 1) {
    const p = plans[i];
    if (p.firstStage > n) continue;
    if (p.text === "loading" || p.text === "error") return p.text;
    return p.text.stages[n - p.firstStage]?.task ?? null;
  }
  return null;
}

const evidenceText = (locale: LocaleId, e: OrchestrationConditions["conditions"][number]["evidence"]): string =>
  e.kind === "check" ? w(locale, "docEvidenceCheck", { cmd: e.command ?? e.check }) : w(locale, e.kind === "change" ? "docEvidenceChange" : "docEvidencePerson");

const requirementLines = (locale: LocaleId, c: OrchestrationConditions): DocLine[] => c.requirements.map((r) => ({
  kind: "item", mark: r.status,
  text: `${r.id} ${r.text}${r.status === "dropped" && r.why ? ` — ${w(locale, "docDroppedWhy", { why: r.why })}` : ""}`
}));

const goalLines = (locale: LocaleId, goal: DocInput["goal"]): DocLine[] =>
  [{ kind: "text", text: loaded(locale, typeof goal === "object" ? goal.text : goal) }];

export function planDoc(input: DocInput, locale: LocaleId): RunDoc {
  const { view, model, plans } = input;
  const say = (k: string, v: Record<string, string | number> = {}) => w(locale, k, v);
  const c = view.progress?.conditions ?? null;
  const sections: DocSection[] = [{ heading: say("docGoal"), lines: goalLines(locale, input.goal) }];
  if (c) sections.push({ heading: say("docRequirements"), lines: requirementLines(locale, c) });
  if (!model.stages?.length) sections.push({ heading: say("orchSum_stages"), lines: [{ kind: "text", text: say("docStagesPending") }] });
  for (const st of model.stages ?? []) {
    const lines: DocLine[] = [{ kind: "text", text: loaded(locale, stageTask(plans, st.n)) }];
    const conds = c?.conditions.filter((x) => x.stage === st.n) ?? [];
    if (conds.length) lines.push({ kind: "text", text: say("docConditions") }, ...conds.map((x): DocLine => ({
      kind: "item", mark: x.status,
      text: `${x.id} ${x.text} — ${evidenceText(locale, x.evidence)}${x.covers.length ? `; ${say("docCovers", { ids: x.covers.join(", ") })}` : ""}`
    })));
    const state = !model.complete && st.state !== "done" ? "orchSumStage_unloaded" : saidKey(view, `orchSumStage_${st.state}`);
    sections.push({ heading: say("docStageHeading", { n: st.n, title: st.title ?? say("docNotSaid"), state: say(state) }), lines });
  }
  const replans = plans.filter((p) => p.version > 1);
  const dropped = c?.dropped ?? [];
  if (replans.length || dropped.length) sections.push({ heading: say("docReplans"), collapsed: true, lines: [
    ...replans.map((p): DocLine => ({ kind: "item", text: say("docReplanLine", { v: p.version, stage: p.firstStage }) })),
    ...dropped.map((d): DocLine => ({ kind: "item", mark: "dropped", text: `${d.id} ${d.text} — ${say("docDroppedWhy", { why: d.why })}` }))
  ] });
  const last = plans.at(-1)?.text;
  if (last && typeof last === "object" && last.question) {
    sections.push({ heading: say("docQuestion"), lines: [{ kind: "text", text: last.question, said: say("docByLead") }] });
  }
  return { title: say("docPlanTitle", { name: docName(input) }), asOf: say("docAsOf", { time: hhmm(locale, input.asOf) }), sections };
}
```

- [ ] **Шаг 5: тесты зелёные**

Run: `node --test tests/orchestration-run-docs.test.mjs`
Expected: PASS, 12 тестов.

Если `t()` в тесте падает на отсутствующем ключе — ключ не добавлен в `ru` или `en` (шаг 2).

- [ ] **Шаг 6: коммит**

```bash
git add src/renderer/src/features/orchestration/runDocs.ts src/renderer/src/features/orchestration/runStatus.ts src/renderer/src/features/orchestration/RunPanel.tsx src/renderer/src/lib/i18n.ts tests/orchestration-run-docs.test.mjs
git commit -m "feat(orchestration): the plan document — goal, requirements, stages with their conditions"
```

---

### Задача 3: `resultDoc`

**Файлы:**
- Изменить: `src/renderer/src/features/orchestration/runDocs.ts`
- Тесты: `tests/orchestration-run-docs.test.mjs`

**Интерфейсы:**
- Использует: `DocInput`, `requirementLines`, `w`, `hhmm`, `docName` (задача 2), `outcomeKey`, `reportParts`
  (`runStatus.ts`), `takenLines` (`runModel.ts`).
- Даёт:
  - `CreatedDocs = { state: "skipped" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; at: string; files: { path: string; body: string | null; why: "loading" | "too_large" | "binary" | "unavailable" | null }[]; more: number }`;
  - `resultDoc(input, docs, locale): RunDoc`.

- [ ] **Шаг 1: падающие тесты**

Импорт расширить на `resultDoc`. Тесты:

```js
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
```

Run: `node --test tests/orchestration-run-docs.test.mjs`
Expected: FAIL — `resultDoc` не экспортирован.

- [ ] **Шаг 2: реализация**

Импорты дополнить:

```ts
import { outcomeKey, reportParts, saidKey, type RunSummaryModel } from "./runStatus.ts";
import { takenLines } from "./runModel.ts";
```

Код:

```ts
export type CreatedFile = { path: string; body: string | null; why: "loading" | "too_large" | "binary" | "unavailable" | null };
// skipped: not read at all (a newer version's run: main gives no changes for it)
export type CreatedDocs = { state: "skipped" } | { state: "loading" } | { state: "error"; message: string }
  | { state: "ready"; at: string; files: CreatedFile[]; more: number };

const WHY = { loading: "docLoading", too_large: "docFileTooLarge", binary: "docFileBinary", unavailable: "docFileUnavailable" } as const;

function createdLines(locale: LocaleId, docs: CreatedDocs): DocLine[] | null {
  if (docs.state === "skipped") return null;
  if (docs.state === "loading") return [{ kind: "text", text: w(locale, "docLoading") }];
  if (docs.state === "error") return [{ kind: "text", text: w(locale, "docDocsError", { message: docs.message }) }];
  const lines: DocLine[] = docs.files.map((f) => ({ kind: "file", path: f.path, body: f.body, note: f.why ? w(locale, WHY[f.why]) : null }));
  if (!docs.files.length) lines.push({ kind: "text", text: w(locale, "docDocsNone") });
  if (docs.more > 0) lines.push({ kind: "text", text: w(locale, "docDocsMore", { n: docs.more }) });
  if (docs.files.length) lines.push({ kind: "text", text: w(locale, `orchChangesAt_${docs.at}`) }); // which tree, as the «Changes» tab says
  return lines;
}

function takeLines(locale: LocaleId, view: OrchestrationRunView, take: OrchestrationTake | null): DocLine[] {
  if (view.workMode === "project") return [{ kind: "text", text: w(locale, "docTakeInPlace") }];
  const taken = takenLines(locale, take);
  if (taken.length) return taken.map((text) => ({ kind: "text", text }));
  return [{ kind: "text", text: view.workMode === "worktree" ? w(locale, "docTakeWorktree", { branch: view.progress?.branch ?? "?" }) : w(locale, "docTakeCopy") }];
}

export function resultDoc(input: DocInput, docs: CreatedDocs, locale: LocaleId): RunDoc {
  const { view, model } = input;
  const say = (k: string, v: Record<string, string | number> = {}) => w(locale, k, v);
  const head: DocLine[] = [{ kind: "text", text: say(saidKey(view, `orchSumOutcome_${outcomeKey(view, model.finalVerdict, model.complete)}`)) }];
  if (model.checkCounts.total > 0) head.push({ kind: "text", text: say("docChecksLine", model.checkCounts) });
  const findings = view.progress?.findings;
  if (findings) head.push({ kind: "text", text: say("docBlockingLine", { n: findings.openBlocking }) });
  head.push({ kind: "text", text: say("docSeeSummary") });
  const sections: DocSection[] = [{ heading: say("docOutcome"), lines: head }];

  const done = (model.stages ?? []).filter((s) => s.state === "done");
  sections.push({ heading: say("docDone"), lines: done.length ? done.map((s): DocLine => {
    const text = s.report ? input.report(s.report.sha256) : null;
    const parts = text && text !== "loading" && text !== "error" ? reportParts(text) : null;
    const summary = parts ? parts.summary ?? parts.text ?? say("docNotSaid") : loaded(locale, text);
    return { kind: "text", text: `${s.title ?? `${say("orchStage")} ${s.n}`}: ${summary}`, said: say("docByExecutor") };
  }) : [{ kind: "text", text: say("docNothingYet") }] });

  const c = view.progress?.conditions ?? null;
  if (c) sections.push({ heading: say("docRequirements"), lines: requirementLines(locale, c) });
  const created = createdLines(locale, docs);
  if (created) sections.push({ heading: say("docDocs"), lines: created });
  sections.push({ heading: say("docTake"), lines: takeLines(locale, view, input.take) });
  return { title: say("docResultTitle", { name: docName(input) }), asOf: say("docAsOf", { time: hhmm(locale, input.asOf) }), sections };
}
```

Проверить, что `outcomeKey` для `view` из теста (`status: "completed"`, `completion: "no_checks"`) даёт
`completed_no_checks`, а `saidKey` при `progress.findings != null` — суффикс `_rv`. Ожидаемый текст первого теста —
`orchSumOutcome_completed_no_checks_rv` из `ru`.

- [ ] **Шаг 3: тесты зелёные**

Run: `node --test tests/orchestration-run-docs.test.mjs`
Expected: PASS, 17 тестов.

- [ ] **Шаг 4: коммит**

```bash
git add src/renderer/src/features/orchestration/runDocs.ts tests/orchestration-run-docs.test.mjs
git commit -m "feat(orchestration): the result document — outcome, what was done, requirements, created documents, how to take it"
```

---

### Задача 4: вкладки «План» и «Результат» в панели запуска

**Файлы:**
- Изменить: `src/renderer/src/features/orchestration/useAgentCanvasUi.ts:12` — `PanelTab`.
- Изменить: `src/renderer/src/features/orchestration/RunPanel.tsx`:
  - вкладки (~1396);
  - широкая панель (~1405);
  - `setEndedHere` (~1267);
  - `orchSummaryOpen` (~1433);
  - список плана на паузе (~1445);
  - тело вкладок (~1597);
  - новые `RunDocView`, `RunDocs`, `useCreatedDocs`.
- Изменить: `src/renderer/src/lib/i18n.ts` — `orchSummaryOpen`: «Открыть результат» / «Open the result».
- Изменить: стили — найти `grep -rn "orch-summary-view" src/renderer/src --include=*.css` и добавить блок `.orch-doc`
  туда же.
- Изменить: `scripts/smoke-orchestration-ui.mjs`.

**Интерфейсы:**
- Использует:
  - `planDoc`, `resultDoc`, `toMarkdown`, `noteText`, `pickDocs`, `addedText`, `PlanEntry`, `CreatedDocs`,
    `CreatedFile`, `RunDoc`, `DocInput` (задачи 1–3);
  - внутри `RunPanel.tsx` (уже есть): `useText`, `parseGoal`, `outcomeOf`, `outcomeText`, `api()`, `summaryModel`,
    `parsePlan`.
- Даёт: `PanelTab` с `"plan" | "result"`. `RunPanel` принимает `onNoteFromText?: (text: string) => void` (вызов
  подключает задача 5).

- [ ] **Шаг 1: `PanelTab`**

`useAgentCanvasUi.ts:12`:

```ts
export type PanelTab = "plan" | "result" | "summary" | "overview" | "activity" | "changes" | "log" | "history";
```

- [ ] **Шаг 2: компоненты документа**

В `RunPanel.tsx`, после `RunSummary`:

```tsx
function RunDocView({ doc, kind, locale, onNote }: { doc: RunDoc; kind: "plan" | "result"; locale: LocaleId; onNote?: (text: string) => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const md = toMarkdown(doc);
  const body = (lines: RunDoc["sections"][number]["lines"]) => lines.map((l, i) => l.kind === "item"
    ? <li key={i} data-doc-mark={l.mark ?? ""}>{l.mark ? <span className={`orch-doc__mark orch-doc__mark--${l.mark}`} aria-hidden="true" /> : null}{l.text}</li>
    : l.kind === "file"
      ? <section key={i} className="orch-doc__file" data-doc-file={l.path}><h5><code>{l.path}</code></h5>{l.body !== null ? <pre>{l.body}</pre> : <p className="orch-hint">{l.note}</p>}</section>
      : <p key={i} className="orch-panel__text">{l.text}{l.said && <i className="orch-doc__said"> ({l.said})</i>}</p>);
  // items of a section are one list; text and files stand between lists
  const group = (lines: RunDoc["sections"][number]["lines"]) => {
    const out: React.ReactNode[] = [];
    let items: RunDoc["sections"][number]["lines"] = [];
    const flush = () => { if (items.length) out.push(<ul key={`u${out.length}`}>{body(items)}</ul>); items = []; };
    lines.forEach((l) => { if (l.kind === "item") items.push(l); else { flush(); out.push(...body([l])); } });
    flush();
    return out;
  };
  return (
    <article className="orch-doc" data-run-doc={kind}>
      <div className="orch-doc__actions">
        <button type="button" data-run-doc-copy onClick={() => { void window.canvasTTY.clipboard.writeText(md); setCopied(true); }}>{t(locale, copied ? "docCopied" : "docCopy")}</button>
        {onNote && <button type="button" data-run-doc-note onClick={() => onNote(noteText(md, t(locale, "docNoteCut")))}>{t(locale, "docToCanvas")}</button>}
      </div>
      <h3>{doc.title}</h3>
      <p className="orch-hint">{doc.asOf}</p>
      {doc.sections.map((s, i) => s.collapsed
        ? <details key={i} className="orch-doc__section"><summary>{s.heading}</summary>{group(s.lines)}</details>
        : <section key={i} className="orch-doc__section"><h4>{s.heading}</h4>{group(s.lines)}</section>)}
    </article>
  );
}

// The documents a task created, read back from their diffs: the list again when the run moves (as the «Changes» tab),
// a file's diff again only when its path or the list's tree changed; one call at a time. Skipped for a newer
// version's run (main gives no changes for it).
function useCreatedDocs(locale: LocaleId, runId: string, seq: number, skip: boolean): { docs: CreatedDocs; retry(): void } {
  const [docs, setDocs] = useState<CreatedDocs>(skip ? { state: "skipped" } : { state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const cache = useRef(new Map<string, CreatedFile>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: seq and attempt are the triggers
  useEffect(() => {
    if (skip) { setDocs({ state: "skipped" }); return; }
    let live = true;
    const id = window.setTimeout(() => void (async () => {
      const ch = await outcomeOf(() => api().changes(runId));
      if (!live) return;
      if (ch.outcome.kind !== "accepted" || !ch.value) { setDocs({ state: "error", message: outcomeText(locale, ch.outcome) }); return; }
      const picked = pickDocs(ch.value.files);
      const files: CreatedFile[] = [];
      for (const path of picked.paths) {
        const key = `${ch.value.atTs ?? ""}:${path}`;
        let file = cache.current.get(key);
        if (!file) {
          const d = await outcomeOf(() => api().diff(runId, path));
          if (!live) return;
          file = d.outcome.kind === "accepted" && d.value ? { path, ...addedText(d.value) } : { path, body: null, why: "unavailable" };
          if (file.why !== "unavailable") cache.current.set(key, file);
        }
        files.push(file);
      }
      setDocs({ state: "ready", at: ch.value.at, files, more: picked.more });
    })(), 300);
    return () => { live = false; window.clearTimeout(id); };
  }, [locale, runId, seq, skip, attempt]);
  return { docs, retry: () => setAttempt((n) => n + 1) };
}

function RunDocs({ kind, orch, runId, view, records, locale, task, take, seq, incomplete, onNote }: {
  kind: "plan" | "result"; orch: Orchestration; runId: string; view: OrchestrationRunView; records: readonly OrchestrationHistoryRecord[];
  locale: LocaleId; task: { key: string; title: string } | null; take: OrchestrationTake | null; seq: number; incomplete: boolean; onNote?: (text: string) => void;
}): React.JSX.Element {
  const planRecords = useMemo(() => records.filter((r) => r.type === "plan.recorded"), [records]);
  const shas = useMemo(() => [
    ...planRecords.map((r) => (r.data.plan as TextRef | undefined)?.sha256),
    ...records.filter((r) => r.type === "turn.finished" || r.type === "orch.turn").map((r) => (r.data.report as TextRef | undefined)?.sha256)
  ].filter((x): x is string => typeof x === "string"), [planRecords, records]);
  useEffect(() => { for (const sha of shas) orch.loadText(runId, sha); }, [orch.loadText, shas, runId]);
  const textOf = (sha: string): Loaded<string> => { const s = orch.texts[sha]; return s?.status === "ready" ? s.text : s?.status === "error" ? "error" : "loading"; };
  const goalText = useText(orch, runId, (records.find((r) => r.type === "run.created")?.data.goal as TextRef | undefined)?.sha256);
  const textsKey = shas.map((sha) => `${sha}:${orch.texts[sha]?.status ?? ""}`).join(",");
  const created = useCreatedDocs(locale, runId, seq, kind !== "result" || !!view.newer);
  // biome-ignore lint/correctness/useExhaustiveDependencies: textsKey stands for orch.texts
  const doc = useMemo(() => {
    const model = summaryModel(view, records, {
      planTitles: (sha) => { const s = orch.texts[sha]; return s?.status === "ready" ? parsePlan(s.text).map((p) => p.title) : null; },
      complete: !incomplete
    });
    const plans: PlanEntry[] = planRecords.map((r, i) => {
      const sha = (r.data.plan as TextRef | undefined)?.sha256;
      const raw = sha ? textOf(sha) : "error";
      let text: Loaded<PlanJson> = raw === "loading" || raw === "error" ? raw : "error";
      if (raw !== "loading" && raw !== "error") {
        try { const p = JSON.parse(raw) as { question?: unknown }; text = { stages: parsePlan(raw), question: typeof p.question === "string" ? p.question : null }; } catch { text = "error"; }
      }
      return { version: i + 1, firstStage: typeof r.data.firstStage === "number" ? r.data.firstStage : 1, text };
    });
    const g = goalText === null ? "loading" : parseGoal(goalText);
    const input: DocInput = {
      view, model, task, plans, take, asOf: new Date().toISOString(), report: textOf,
      goal: g === "loading" ? "loading" : g ? { text: typeof g.text === "string" ? g.text : null } : { text: goalText }
    };
    return kind === "plan" ? planDoc(input, locale) : resultDoc(input, created.docs, locale);
  }, [kind, view, records, planRecords, textsKey, goalText, task, take, created.docs, incomplete, locale]);
  return <>
    <RunDocView doc={doc} kind={kind} locale={locale} onNote={onNote} />
    {kind === "result" && created.docs.state === "error" && <button type="button" data-run-doc-retry onClick={created.retry}>{t(locale, "orchRepeat")}</button>}
  </>;
}
```

Перед реализацией сверить с кодом:

- **Отчёты исполнителя.** Типы событий, в которых лежит `report`, взять из `summaryModel` (`runStatus.ts`, где
  заполняется `SummaryStage.report`) и поставить их вместо `"turn.finished" || "orch.turn"`. Цель — грузить только
  тексты отчётов.
- **`useText`.** Проверить, что он возвращает `null`, пока текст не загружен. Иначе поправить условие
  `goalText === null`.
- **`take`.** Взять то же значение, что использует `TakeResult` в `CurrentRunPanel` (переменная `take`, строка ~1626).
- **Импорты.** `Orchestration`, `OrchestrationHistoryRecord`, `OrchestrationTake`, `TextRef` в `RunPanel.tsx` уже есть —
  проверить по началу файла.

- [ ] **Шаг 3: вкладки, широкая панель, «Открыть результат», «Открыть план»**

В `CurrentRunPanel`:

```tsx
const tabs: PanelTab[] = view?.newer ? ["plan", "result", "summary", "overview", "activity", "log", "history"] : ["plan", "result", "summary", "overview", "activity", "changes", "log", "history"];
```

```tsx
const wide = panel.tab === "summary" || panel.tab === "plan" || panel.tab === "result";
<aside className={`orch-panel${wide ? " orch-panel--wide" : ""}${expanded ? " orch-panel--full" : ""}`} …
```

```tsx
useEffect(() => { if (panel.tab === "summary" || panel.tab === "result") setEndedHere(false); }, [panel.tab]);
```

Блок `endedHere`: `panel.tab !== "summary"` → `panel.tab !== "summary" && panel.tab !== "result"`;
`onView({ tab: "summary" })` → `onView({ tab: "result" })`.

Список плана на паузе проверки:

```tsx
{head.headline === "awaiting_plan_review" && panel.tab !== "plan" && (
  <button type="button" className="orch-primary" data-orch-open-plan onClick={() => onView({ tab: "plan" })}>{t(locale, "docOpenPlan")}</button>
)}
```

После этой правки переменные `plan` и `planFirst` могут оказаться нигде не использованы. Если так — удалить их
объявления. Подпись вкладки идёт через `orchTab_${tab}`, поэтому `orchTab_plan` и `orchTab_result` из задачи 2
подхватятся сами.

Тело, перед блоком `panel.tab === "summary"`:

```tsx
{(panel.tab === "plan" || panel.tab === "result") && runId && (records.length
  ? <RunDocs kind={panel.tab} orch={orch} runId={runId} view={view} records={records} locale={locale} task={task ?? null} take={take}
    seq={view.seq ?? 0} incomplete={journal?.status !== "ready"} onNote={onNoteFromText} />
  : <p className="orch-hint">{t(locale, "orchLoading")}</p>)}
```

`seq` взять тот же, что `ChangesTab` получает в этом файле (найти `<ChangesTab`). `onNoteFromText` — новый
необязательный проп `RunPanelProps`. `RunPanel` передаёт его в `CurrentRunPanel` так же, как остальные пропы.

- [ ] **Шаг 4: стили**

```css
.orch-doc { display: grid; gap: 10px; }
.orch-doc h3 { margin: 0; font-size: 1.05em; }
.orch-doc__actions { display: flex; gap: 8px; justify-content: flex-end; }
.orch-doc__section h4, .orch-doc__section summary { margin: 6px 0 4px; font-weight: 600; }
.orch-doc__section ul { margin: 0; padding-left: 18px; }
.orch-doc__said { opacity: 0.7; }
.orch-doc__file pre { white-space: pre-wrap; word-break: break-word; max-height: 480px; overflow: auto; }
.orch-doc__mark { display: inline-block; width: 1.2em; }
.orch-doc__mark--met::before { content: "✓"; }
.orch-doc__mark--not_met::before { content: "✗"; }
.orch-doc__mark--not_checked::before { content: "…"; }
.orch-doc__mark--dropped::before { content: "—"; }
.orch-doc__mark--open::before { content: "•"; }
```

- [ ] **Шаг 5: typecheck и тесты**

Run: `npm run typecheck && node --test tests/orchestration-run-docs.test.mjs`
Expected: без ошибок, PASS.

- [ ] **Шаг 6: smoke**

В `scripts/smoke-orchestration-ui.mjs`:

1. Проверку `[data-orch-summary-plan] li` (строки ~217–219) заменить:

```js
  const openPlan = await visibleNow(app, q("[data-orch-open-plan]"));
  expect(openPlan.ok, "plan review: «Open the plan» is in the summary, in view", openPlan);
  await app.clickEl(q("[data-orch-open-plan]"));
  await app.waitFor(`${q('[data-run-doc="plan"]')}?.textContent.includes("Add src/note.mjs exporting a constant")`, "plan tab shows the stage's task");
  expect(true, "plan review: the plan tab shows the stage's task in full", null);
```

2. После завершения run 1, где smoke уже открывает «Итог»:

```js
  await openTab(app, "result");
  await app.waitFor(`${q('[data-run-doc="result"]')}?.textContent.includes("note and extra test added")`, "result tab shows what was done");
  expect(true, "completed: the result tab shows what the executor did", null);
  await app.clickEl(q("[data-run-doc-copy]"));
  const copied = await app.ev("window.canvasTTY.clipboard.readText()");
  expect(typeof copied === "string" && copied.startsWith("# "), "the result is copied as markdown", copied?.slice(0, 80));
  await openTab(app, "plan");
  await app.waitFor(`${q('[data-run-doc="plan"]')}?.textContent.includes("Заметка")`, "plan tab shows the stage");
  expect(true, "completed: the plan tab shows the stage", null);
```

Если smoke проверяет текст кнопки «Открыть итог», заменить его на «Открыть результат».

Run: `npm run build && node scripts/smoke-orchestration-ui.mjs`
Expected: `"ok": true`.

С `CANVASTTY_JOURNAL_V2=1` прогнать тоже: `CANVASTTY_JOURNAL_V2=1 node scripts/smoke-orchestration-ui.mjs`.

- [ ] **Шаг 7: коммит**

```bash
git add src/renderer/src scripts/smoke-orchestration-ui.mjs
git commit -m "feat(orchestration): Plan and Result tabs of the run panel"
```

---

### Задача 5: «На холст» — заметка со снимком документа

**Файлы:**
- Изменить: `src/renderer/src/features/workspace/WorkspaceCanvas.tsx` — `noteFromText` рядом с `createNote` (~665),
  проп в `<OrchestrationOverlays …>` (~1262).
- Изменить: `src/renderer/src/features/orchestration/OrchestrationDialogs.tsx:607-624` — проп `onNoteFromText` в
  `OrchestrationOverlays` и в `<RunPanel>`.
- Изменить: `scripts/smoke-orchestration-ui.mjs`.

**Интерфейсы:**
- Использует: `RunPanel` проп `onNoteFromText?: (text: string) => void` (задача 4), `stickyNoteAtPoint`,
  `viewportCenterWorldPoint`, `onCreateStickyNote`.

- [ ] **Шаг 1: `WorkspaceCanvas`**

```tsx
  // a run document's snapshot as a note in the middle of the view (plan-result-docs.md §5): the active workspace
  const noteFromText = useCallback((text: string): void => {
    onCreateStickyNote({ ...stickyNoteAtPoint(viewportCenterWorldPoint(), crypto.randomUUID()), text });
  }, [onCreateStickyNote, viewportCenterWorldPoint]);
```

```tsx
<OrchestrationOverlays taskOfRun={board.taskOfRun} orch={orch} ui={agentUi} locale={settings.locale} defaultProject={settings.lastDirectory} folderBusy={folderBusy} onNoteFromText={noteFromText} />
```

- [ ] **Шаг 2: `OrchestrationOverlays`**

В деструктуризацию и тип пропов добавить `onNoteFromText?: (text: string) => void`. В `<RunPanel …>` добавить
`onNoteFromText={onNoteFromText}`.

- [ ] **Шаг 3: smoke**

После проверки «Копировать» из задачи 4:

```js
  const notesBefore = await app.ev(`document.querySelectorAll("[data-sticky-note-id], .sticky-note").length`);
  await app.clickEl(q("[data-run-doc-note]"));
  await app.waitFor(`document.querySelectorAll("[data-sticky-note-id], .sticky-note").length === ${notesBefore} + 1`, "a note added");
  const noteText = await app.ev(`[...document.querySelectorAll("[data-sticky-note-id] textarea, .sticky-note textarea")].at(-1)?.value ?? null`);
  expect(typeof noteText === "string" && noteText.startsWith("# ") && noteText.includes("— план"), "«To the canvas» puts the plan on the canvas as a note", noteText?.slice(0, 80));
```

Селектор заметки сверить с `StickyNoteCard.tsx` (корневой элемент и `textarea`) и оставить один точный.

Run: `npm run build && node scripts/smoke-orchestration-ui.mjs`
Expected: `"ok": true`.

- [ ] **Шаг 4: коммит**

```bash
git add src/renderer/src/features/workspace/WorkspaceCanvas.tsx src/renderer/src/features/orchestration/OrchestrationDialogs.tsx scripts/smoke-orchestration-ui.mjs
git commit -m "feat(orchestration): a run document's snapshot as a note on the canvas"
```

---

### Задача 6: кнопки «План» и «Результат» на карточке задачи

**Файлы:**
- Изменить: `src/renderer/src/features/orchestration/BoardCard.tsx:225-227`
- Изменить: `scripts/smoke-board-ui.mjs`

**Интерфейсы:**
- Использует: `ui.openRunById(runId, tab)` (`useAgentCanvasUi.ts:105`), `PanelTab` (задача 4).

- [ ] **Шаг 1: кнопки**

Сразу после кнопки `data-board-open` / `data-board-answer`:

```tsx
{runId && <>
  <button type="button" data-board-open-plan onClick={() => ui.openRunById(runId, "plan")}>{t(locale, "orchTab_plan")}</button>
  <button type="button" data-board-open-result onClick={() => ui.openRunById(runId, "result")}>{t(locale, "orchTab_result")}</button>
</>}
```

- [ ] **Шаг 2: smoke**

В `scripts/smoke-board-ui.mjs` — после места, где задача дошла до «Готово» и проверены её строки. Функция `task(key)`
уже есть в smoke.

```js
  await app.clickEl(`${q(task("T-1"))}.querySelector("[data-board-open-result]")`);
  await app.waitFor(`${q('[data-orch-panel-tab="result"] [data-run-doc="result"]')} !== null`, "board: Result opens the result tab");
  expect(true, "board: «Result» on the card opens the run's result", null);
  await app.clickEl(`${q(task("T-1"))}.querySelector("[data-board-open-plan]")`);
  await app.waitFor(`${q('[data-orch-panel-tab="plan"] [data-run-doc="plan"]')} !== null`, "board: Plan opens the plan tab");
  expect(true, "board: «Plan» on the card opens the run's plan", null);
```

Ключ задачи (`"T-1"`) и функцию проверки (`expect` или её аналог в этом smoke) взять из окружающего кода.

Run: `npm run build && node scripts/smoke-board-ui.mjs`
Expected: `"ok": true`.

- [ ] **Шаг 3: коммит**

```bash
git add src/renderer/src/features/orchestration/BoardCard.tsx scripts/smoke-board-ui.mjs
git commit -m "feat(board): Plan and Result on a task's card"
```

---

### Задача 7: полная проверка и правка спецификации

**Файлы:**
- Изменить: `docs/agent-orchestration/implementation/plan-result-docs.md`.

- [ ] **Шаг 1: спецификация по факту**

1. §5: цепочка — `WorkspaceCanvas` → `OrchestrationOverlays` → `RunPanel`, без `AgentScene`.
2. §3.3: строка `orchChangesAt_<at>` показывается всегда, когда есть документы (как во вкладке «Изменения»), а не
   только при «не финальном» дереве.
3. Статус: «реализовано, на ревью».

- [ ] **Шаг 2: полный прогон**

```bash
npm run typecheck
npm run lint
npm test
npm run build
node scripts/smoke-orchestration-ui.mjs
CANVASTTY_JOURNAL_V2=1 node scripts/smoke-orchestration-ui.mjs
node scripts/smoke-board-ui.mjs
node scripts/smoke-board-parallel-ui.mjs
node scripts/smoke-activity-ui.mjs
```

Expected:
- typecheck без ошибок;
- lint — без новых ошибок, предупреждений не больше прежних 268;
- `npm test` — 0 упавших;
- все smoke — `"ok": true`.

- [ ] **Шаг 3: ручная проверка на реальном запуске**

Собранное приложение, профиль владельца, запуск T-1 в career-os (`a0734db5`). Открыть «План» и «Результат». В
«Созданных документах» виден текст `business-logic-review-2026-10-11.md`. Снять снимки обеих вкладок в
`docs/ux-audit/<дата>/run-docs/`.

- [ ] **Шаг 4: коммит**

```bash
git add docs/agent-orchestration/implementation/plan-result-docs.md docs/ux-audit
git commit -m "docs(orchestration): plan and result documents — as built"
```
