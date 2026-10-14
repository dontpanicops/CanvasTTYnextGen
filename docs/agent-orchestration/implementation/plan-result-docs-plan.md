# План реализации: документы «План» и «Результат» запуска

Выполнение: по задачам по порядку, шаги — чекбоксы `- [ ]`. Каждая задача заканчивается зелёными тестами и коммитом.

**Цель:** две новые вкладки панели запуска — «План» и «Результат». Это короткие документы, которые приложение собирает
из журнала. Их можно скопировать или положить на холст заметкой. Кнопки на карточке задачи доски открывают их сразу.

**Архитектура:** чистые функции в новом `runDocs.ts` строят `RunDoc` (заголовок, разделы, строки). Из `RunDoc` рисуется
React-вид и собирается markdown. Данные берутся из того, что renderer уже получает: `view`, история журнала, тексты через
`orch.loadText`, `api().changes`, `api().diff` и один новый вызов `api().file` — точный текст файла из дерева запуска
(`git cat-file blob <tree>:<path>` в `control.git` запуска). Журнал не меняется.

**Правки владельца перед кодом (2026-10-14):**
1. Текст созданного документа — сначала точно из Git (`api().file`, то же дерево, что у вкладки «Изменения»: живой
   снимок, последняя проверка или последняя контрольная точка). Восстановление из diff — только запасной путь, когда
   точное чтение не удалось; тогда у файла пометка «восстановлено из изменений». Тесты на оба пути (задача 3б).
2. «На холст» — снимок. В заметке видно «Копия документа на <дата, время>» и кнопка «Открыть актуальный». После
   перепланирования снимок на холсте остаётся помеченной копией и не выдаёт себя за текущий план (задача 5).

**Стек:** TypeScript, React, `node --test` (тесты импортируют `.ts` renderer напрямую), Electron smoke через
`scripts/orchestration-app-kit.mjs`.

**Спецификация:** [plan-result-docs.md](plan-result-docs.md), ревизия 2. Читать вместе с этим планом.

## Общие ограничения

- Журнал не меняется. Main и IPC: только новый вызов `orchestration:file` (чтение, ничего не пишет). `settings.json`:
  только необязательное поле `source` у заметки; старые версии его отбрасывают, текст заметки остаётся.
- Агентам ничего нового не поручается. Текст агента всегда помечен «со слов исполнителя» или «со слов лида».
- Непрочитанное — «загружается…», непрочитанное с ошибкой — «не удалось прочитать». Выдумывать нельзя.
- Созданные документы: только `added` с расширением `.md`, `.markdown` или `.txt`. Не больше 10. Чтение по одному
  файлу, лимит 256 КиБ (и у точного чтения, и у diff).
- Заметка: не больше 20 000 символов вместе с плашкой снимка и строкой об обрезке (столько хранит `SettingsStore`
  и пропускает `maxLength` поля заметки), кладётся в активное пространство, в центр видимой области.
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
5. **Очень длинный документ на холст.** Заметка обрезана до 20 000 символов (с плашкой и строкой об обрезке), `settings.json` не раздувается. Задачи 1
   и 5.
6. **Точное чтение не удалось, diff есть.** Текст восстановлен из diff и помечен; ни в панели, ни в markdown не
   выглядит точным. Точное чтение сказало «больше 256 КиБ» или «не текст» — diff не запрашивается. Задачи 1 и 3б.
7. **Снимок на холсте после перепланирования.** Заметка помнит, откуда она (`source`), всегда показывает «Копия
   документа на …» и «Открыть актуальный»; кнопка открывает текущую вкладку запуска. Заметка из старой версии без
   `source` — обычная заметка. Задача 5.

## Файлы

| Файл | Что |
|---|---|
| `src/renderer/src/features/orchestration/runDocs.ts` (новый) | типы `RunDoc`, `planDoc`, `resultDoc`, `toMarkdown`, `noteText`, `addedText`, `pickDocs`, `stageTask`, `readCreatedFile`, `snapshotText` |
| `src/main/services/orchestration/workspace.ts` | `readTreeFile` — блоб файла из дерева `control.git` |
| `src/main/services/orchestration/manager.ts` | метод `file(runId, path)` рядом с `diff` |
| `src/main/ipc/orchestrationIpc.ts`, `src/shared/contracts.ts` (`IPC`), `src/preload/orchestrationClient.ts`, `src/shared/orchestration.ts` | вызов `orchestration:file`, тип `OrchestrationFile` |
| `src/shared/contracts.ts` (`StickyNote`), `src/main/services/SettingsStore.ts` (`normalizeStickyNotes`) | необязательное `source` у заметки |
| `src/renderer/src/features/notes/StickyNoteCard.tsx` | плашка «Копия документа на …» и «Открыть актуальный» |
| `src/renderer/src/features/orchestration/runStatus.ts` | перенос `REVIEWER_WORDS` и новый `saidKey` |
| `src/renderer/src/features/orchestration/RunPanel.tsx` | `RunDocView`, `RunDocs`, `useCreatedDocs`, вкладки, ссылка «Открыть план», «Открыть результат», проп `onNoteFromText` |
| `src/renderer/src/features/orchestration/useAgentCanvasUi.ts` | `PanelTab` |
| `src/renderer/src/features/orchestration/OrchestrationDialogs.tsx` | проброс `onNoteFromText` в `RunPanel` |
| `src/renderer/src/features/workspace/WorkspaceCanvas.tsx` | `noteFromText`, проп в `OrchestrationOverlays` |
| `src/renderer/src/features/orchestration/BoardCard.tsx` | кнопки «План» и «Результат» |
| `src/renderer/src/lib/i18n.ts` | строки `doc*`, `orchTab_plan`, `orchTab_result`; новый текст `orchSummaryOpen` |
| стили панели (файл, где описан `.orch-summary-view`) | `.orch-doc` |
| `tests/orchestration-run-docs.test.mjs` (новый) | модульные тесты |
| `tests/orchestration-run-file.test.mjs` (новый), `tests/sticky-notes.test.mjs` или `tests/settings-normalizer.test.mjs` | точное чтение в main; `source` заметки |
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
  - `noteText(markdown, cut): string`, `NOTE_MAX = 20_000` (весь текст заметки, с хвостом).

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
  | { kind: "file"; path: string; body: string | null; note: string | null }; // note: why there is no body, or how the body was read
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
      else if (l.body !== null) out.push(`### ${l.path}`, "", ...(l.note ? [`_${l.note}_`, ""] : []), l.body.replace(/\n$/, ""));
      else out.push(`### ${l.path}`, "", l.note ?? "");
      prev = l.kind;
    }
  }
  return `${out.join("\n")}\n`;
}

// Notes live in settings.json, which keeps 20 000 characters of a note (SettingsStore, the note's maxLength): a snapshot
// on the canvas is cut to that, its closing line included, so nothing is cut again silently.
export const NOTE_MAX = 20_000;
export function noteText(markdown: string, cut: string): string {
  if (markdown.length <= NOTE_MAX) return markdown;
  const tail = `\n\n${cut}\n`;
  return `${markdown.slice(0, NOTE_MAX - tail.length)}${tail}`;
}
```

- [ ] **Шаг 4: тесты зелёные**

Run: `node --test tests/orchestration-run-docs.test.mjs`
Expected: PASS, 8 тестов.

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
Expected: PASS, 18 тестов.

- [ ] **Шаг 4: коммит**

```bash
git add src/renderer/src/features/orchestration/runDocs.ts tests/orchestration-run-docs.test.mjs
git commit -m "feat(orchestration): the result document — outcome, what was done, requirements, created documents, how to take it"
```

---

### Задача 3б: точный текст созданного файла из Git, diff — запасной путь

**Файлы:**
- Изменить: `src/main/services/orchestration/workspace.ts` — `readTreeFile` после `diffTreePath` (~771).
- Изменить: `src/main/services/orchestration/manager.ts` — метод `file` после `diff` (~1255).
- Изменить: `src/shared/orchestration.ts` — `OrchestrationFile` после `OrchestrationDiff` (~464), `file(...)` в API
  после `diff(...)` (~609).
- Изменить: `src/shared/contracts.ts` — `orchestrationFile: "orchestration:file"` после `orchestrationDiff` (~1171).
- Изменить: `src/main/ipc/orchestrationIpc.ts` — обработчик после `orchestrationDiff` (~362), та же проверка пути.
- Изменить: `src/preload/orchestrationClient.ts` — `file` после `diff` (~55).
- Изменить: `src/renderer/src/features/orchestration/runDocs.ts` — `CreatedFile.restored`, `readCreatedFile`,
  пометка в `createdLines`.
- Изменить: `src/renderer/src/lib/i18n.ts` — `docFileRestored` (ru и en).
- Тесты: `tests/orchestration-native.test.mjs` (main, рядом с проверкой `m.changes` ~234),
  `tests/orchestration-run-docs.test.mjs`.

**Интерфейсы:**
- Использует: `changeTarget`, `diffTreeNames`, `controlCtx`, `run`, `requireOid` (main, уже есть); `addedText`,
  `CreatedFile`, `createdLines` (задачи 1, 3).
- Даёт (для задачи 4):
  - `OrchestrationFile = { path: string; text: string | null; why: "too_large" | "binary" | null }`;
  - `api().file(runId, path): Promise<OrchestrationResult<OrchestrationFile>>`;
  - `CreatedFile` с необязательным `restored?: true`;
  - `readCreatedFile(path, exact: () => Promise<OrchestrationFile | null>, diff: () => Promise<OrchestrationDiff | null>): Promise<CreatedFile>`.

- [ ] **Шаг 1: падающие тесты renderer**

В `tests/orchestration-run-docs.test.mjs` импорт расширить на `readCreatedFile`:

```js
const never = () => { throw new Error("diff must not be read"); };
test("readCreatedFile: the exact text first, the diff never asked for", async () => {
  assert.deepEqual(await readCreatedFile("docs/a.md", async () => ({ path: "docs/a.md", text: "# A\n", why: null }), never), { path: "docs/a.md", body: "# A\n", why: null });
});
test("readCreatedFile: too large or not text from the exact read is final", async () => {
  assert.deepEqual(await readCreatedFile("b.md", async () => ({ path: "b.md", text: null, why: "too_large" }), never), { path: "b.md", body: null, why: "too_large" });
  assert.deepEqual(await readCreatedFile("c.md", async () => ({ path: "c.md", text: null, why: "binary" }), never), { path: "c.md", body: null, why: "binary" });
});
test("readCreatedFile: the exact read failed — restored from the diff, marked", async () => {
  assert.deepEqual(await readCreatedFile("docs/a.md", async () => null, async () => diffOf(["# A"])), { path: "docs/a.md", body: "# A\n", why: null, restored: true });
});
test("readCreatedFile: both failed — unavailable", async () => {
  assert.deepEqual(await readCreatedFile("docs/a.md", async () => null, async () => null), { path: "docs/a.md", body: null, why: "unavailable" });
});
test("resultDoc: a restored document says so, in the view and in markdown", () => {
  const doc = resultDoc(done(), ready([{ path: "docs/a.md", body: "# A\n", why: null, restored: true }]), "ru");
  const f = doc.sections.find((s) => s.heading === "Созданные документы").lines[0];
  assert.equal(f.note, "Восстановлено из изменений: точный текст файла прочитать не удалось.");
  assert.match(toMarkdown(doc), /_Восстановлено из изменений: точный текст файла прочитать не удалось\._\n\n# A/);
});
```

Run: `node --test tests/orchestration-run-docs.test.mjs` → FAIL (`readCreatedFile` не экспортирован).

- [ ] **Шаг 2: renderer**

`runDocs.ts` (импорт типов дополнить `OrchestrationFile`):

```ts
export type CreatedFile = { path: string; body: string | null; why: "loading" | "too_large" | "binary" | "unavailable" | null; restored?: true };

// A created document's text (plan-result-docs.md §3.3): exactly from the run's Git tree first; read back from its diff
// only when that read failed, and then marked. Too large or not text is the file's own answer: no diff is asked for.
export async function readCreatedFile(path: string, exact: () => Promise<OrchestrationFile | null>, diff: () => Promise<OrchestrationDiff | null>): Promise<CreatedFile> {
  const f = await exact();
  if (f) return { path, body: f.text, why: f.why };
  const d = await diff();
  return d ? { path, ...addedText(d), restored: true } : { path, body: null, why: "unavailable" };
}
```

`createdLines`: `note: f.why ? w(locale, WHY[f.why]) : f.restored ? w(locale, "docFileRestored") : null`.

i18n: `docFileRestored` — ru «Восстановлено из изменений: точный текст файла прочитать не удалось.», en «Restored from
the changes: the file's exact text could not be read.».

- [ ] **Шаг 3: падающий тест main**

В `tests/orchestration-native.test.mjs`, сразу после `assert.ok(changes.value.files.some((f) => f.path === "note.txt"), …)`:

```js
  const exact = await m.file(runId, "note.txt");
  assert.deepEqual(exact.value, { path: "note.txt", text: "hello\n", why: null }, JSON.stringify(exact));
  const outside = await m.file(runId, "user.txt");
  assert.equal(outside.ok, false, "only a path the run's changes name");
  assert.equal(outside.value.code ?? outside.error?.code, "invalid_argument", JSON.stringify(outside));
```

Форму отказа (`ok`/`value.code`) сверить с тем, как в этом же файле проверяются другие отказы `m.*`, и оставить одну.

Отдельный тест на `readTreeFile` в том же файле: репозиторий через `createWorkspace` (как другие тесты файла), в дереве
файл с байтом `\0` и файл больше `maxBytes` (передать `maxBytes = 16`):
- `{ bytes, truncated: false }` для обычного файла, байты совпадают;
- `{ bytes: null, truncated: true }` для большого (блоб целиком не читается: сначала `cat-file -s`);
- путь с `..` или абсолютный — ошибка `invalid_input`.

Run: `node --test tests/orchestration-native.test.mjs` → FAIL (`m.file is not a function`).

- [ ] **Шаг 4: main**

`workspace.ts`:

```ts
// A file of a tree of the control repository, exactly as stored (Git objects only, nothing written). Over maxBytes the
// blob is not read at all: the caller says the file is too large.
export async function readTreeFile(ws: Workspace, tree: string, path: string, maxBytes = 256 * 1024): Promise<{ bytes: Buffer | null; truncated: boolean }> {
  requireOid(tree, "tree");
  if (typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes("..") || path.includes("\0")) fail("invalid_input", "path must be relative");
  const spec = `${tree}:${path}`;
  const size = Number((await run(controlCtx(ws), ["cat-file", "-s", spec])).toString("utf8").trim());
  if (!Number.isFinite(size) || size > maxBytes) return { bytes: null, truncated: true };
  return { bytes: await run(controlCtx(ws), ["cat-file", "blob", spec]), truncated: false };
}
```

`manager.ts`, после `diff`:

```ts
    // One file's exact text in the tree the change list reads, only for a path that list names (plan-result-docs.md).
    file: (runId: string, path: string) => result(async (): Promise<OrchestrationFile> => {
      const { ws, st, target } = await changeTarget(runIdOk(runId));
      const names = await diffTreeNames(ws, st.workspace!.baseline.tree, target.tree);
      const f = names.files.find((x) => x.path === path);
      if (!f || f.status === "deleted") refuse("invalid_argument", "the path is not a file in this run's changes");
      const r = await readTreeFile(ws, target.tree, path);
      if (!r.bytes) return { path, text: null, why: "too_large" };
      // as Git decides: a NUL in the first 8000 bytes is not text
      if (r.bytes.subarray(0, 8000).includes(0)) return { path, text: null, why: "binary" };
      return { path, text: r.bytes.toString("utf8"), why: null };
    }),
```

Импорт `readTreeFile` добавить в строку импорта из `./workspace.ts` (~49), `OrchestrationFile` — к импорту типов.

`orchestration.ts`: `export interface OrchestrationFile { path: string; text: string | null; why: "too_large" | "binary" | null }`
и в API `file(runId: string, path: string): Promise<OrchestrationResult<OrchestrationFile>>;`.

`contracts.ts`: `orchestrationFile: "orchestration:file",`.

`orchestrationIpc.ts`:

```ts
  handleMain(IPC.orchestrationFile, (_e, runId: unknown, path: unknown) => checked(() => {
    const p = str(path, "path", 4096);
    if (p.startsWith("/") || p.split("/").includes("..")) bad("path must be relative to the copy");
    return [uuid(runId, "runId"), p] as [string, string];
  }, manager.file));
```

`orchestrationClient.ts`: `file: (runId, path) => ipc.invoke(IPC.orchestrationFile, runId, path),`.

Если есть список разрешённых каналов IPC или тест, сверяющий `IPC` с preload (`grep -rn "orchestrationDiff" src tests`),
добавить `orchestrationFile` туда же.

- [ ] **Шаг 5: тесты и typecheck**

Run: `npm run typecheck && node --test tests/orchestration-run-docs.test.mjs tests/orchestration-native.test.mjs`
Expected: без ошибок, PASS.

- [ ] **Шаг 6: коммит**

```bash
git add src/main src/shared src/preload src/renderer/src/features/orchestration/runDocs.ts src/renderer/src/lib/i18n.ts tests/orchestration-run-docs.test.mjs tests/orchestration-native.test.mjs
git commit -m "feat(orchestration): a created document's exact text from the run's tree, its diff only as a fallback"
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
  - `planDoc`, `resultDoc`, `toMarkdown`, `pickDocs`, `readCreatedFile`, `PlanEntry`, `CreatedDocs`,
    `CreatedFile`, `RunDoc`, `DocInput` (задачи 1–3б); `api().file` (задача 3б);
  - внутри `RunPanel.tsx` (уже есть): `useText`, `parseGoal`, `outcomeOf`, `outcomeText`, `api()`, `summaryModel`,
    `parsePlan`.
- Даёт: `PanelTab` с `"plan" | "result"`. `RunPanel` принимает
  `onNoteFromText?: (markdown: string, source: { runId: string; doc: "plan" | "result" }) => void` (вызов
  подключает задача 5).

- [ ] **Шаг 1: `PanelTab`**

`useAgentCanvasUi.ts:12`:

```ts
export type PanelTab = "plan" | "result" | "summary" | "overview" | "activity" | "changes" | "log" | "history";
```

- [ ] **Шаг 2: компоненты документа**

В `RunPanel.tsx`, после `RunSummary`:

```tsx
function RunDocView({ doc, kind, locale, onNote }: { doc: RunDoc; kind: "plan" | "result"; locale: LocaleId; onNote?: (markdown: string) => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const md = toMarkdown(doc);
  const body = (lines: RunDoc["sections"][number]["lines"]) => lines.map((l, i) => l.kind === "item"
    ? <li key={i} data-doc-mark={l.mark ?? ""}>{l.mark ? <span className={`orch-doc__mark orch-doc__mark--${l.mark}`} aria-hidden="true" /> : null}{l.text}</li>
    : l.kind === "file"
      ? <section key={i} className="orch-doc__file" data-doc-file={l.path}><h5><code>{l.path}</code></h5>{l.note && <p className="orch-hint" data-doc-file-note>{l.note}</p>}{l.body !== null && <pre>{l.body}</pre>}</section>
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
        {onNote && <button type="button" data-run-doc-note onClick={() => onNote(md)}>{t(locale, "docToCanvas")}</button>}
      </div>
      <h3>{doc.title}</h3>
      <p className="orch-hint">{doc.asOf}</p>
      {doc.sections.map((s, i) => s.collapsed
        ? <details key={i} className="orch-doc__section"><summary>{s.heading}</summary>{group(s.lines)}</details>
        : <section key={i} className="orch-doc__section"><h4>{s.heading}</h4>{group(s.lines)}</section>)}
    </article>
  );
}

// The documents a task created, exactly from the run's tree (their diff only as a fallback): the list again when the run
// moves (as the «Changes» tab), a file again only when its path or the list's tree changed; one call at a time. Skipped for a newer
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
          const ok = async <T,>(call: () => Promise<OrchestrationResult<T>>): Promise<T | null> => {
            const r = await outcomeOf(call);
            return r.outcome.kind === "accepted" && r.value ? r.value : null;
          };
          file = await readCreatedFile(path, () => ok(() => api().file(runId, path)), () => ok(() => api().diff(runId, path)));
          if (!live) return;
          // a restored text is not kept: the next pass tries the exact read again
          if (file.why !== "unavailable" && !file.restored) cache.current.set(key, file);
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
  locale: LocaleId; task: { key: string; title: string } | null; take: OrchestrationTake | null; seq: number; incomplete: boolean; onNote?: (markdown: string, source: { runId: string; doc: "plan" | "result" }) => void;
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
    <RunDocView doc={doc} kind={kind} locale={locale} onNote={onNote && ((md) => onNote(md, { runId, doc: kind }))} />
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
  `OrchestrationResult` (для `ok` в `useCreatedDocs`) добавить к импорту типов из `shared/orchestration`, если его нет.

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

### Задача 5: «На холст» — заметка-снимок с «Открыть актуальный»

**Файлы:**
- Изменить: `src/shared/contracts.ts:173` — `StickyNoteSource`, необязательное `source` у `StickyNote`.
- Изменить: `src/main/services/SettingsStore.ts` — `normalizeStickyNotes` (~745) сохраняет проверенное `source`.
- Изменить: `src/renderer/src/features/orchestration/runDocs.ts` — `snapshotText`.
- Изменить: `src/renderer/src/features/notes/StickyNoteCard.tsx` — плашка снимка и кнопка, проп `onOpenSource`.
- Изменить: `src/renderer/src/features/workspace/WorkspaceCanvas.tsx` — `noteFromText` рядом с `createNote` (~664);
  проп в `<OrchestrationOverlays …>`; `onOpenSource` у `<StickyNoteCard>` (~1040); тип `tab` у
  `openRunInWorkspace` (~254) расширить до `PanelTab`.
- Изменить: `src/renderer/src/features/orchestration/OrchestrationDialogs.tsx:607-624` — проп `onNoteFromText` в
  `OrchestrationOverlays` и в `<RunPanel>`.
- Изменить: `src/renderer/src/lib/i18n.ts` — `docSnapshotLine`, `noteSnapshotOf`, `noteOpenCurrent` (ru и en).
- Стили: рядом с `.sticky-note-card__header` — `.sticky-note-card__source`.
- Тесты: `tests/orchestration-run-docs.test.mjs`, `tests/settings-normalizer.test.mjs` (или `tests/sticky-notes.test.mjs`
  — где уже проверяется `normalizeStickyNotes`).
- Изменить: `scripts/smoke-orchestration-ui.mjs`.

**Интерфейсы:**
- Использует: `RunPanel` проп `onNoteFromText?: (markdown: string, source: { runId: string; doc: "plan" | "result" }) => void`
  (задача 4); `noteText`, `NOTE_MAX` (задача 1); `stickyNoteAtPoint`, `viewportCenterWorldPoint`, `onCreateStickyNote`,
  `openRunInWorkspace` (`WorkspaceCanvas`).
- Даёт: `StickyNoteSource = { runId: string; doc: "plan" | "result"; at: string }` (ISO-время снимка);
  `snapshotText(markdown, locale, at): string`.

Почему так: снимок никогда не обновляется сам. Он честно говорит, что он копия и на какое время, — и в тексте (первая
строка, видна в любой версии приложения и при копировании заметки), и плашкой над текстом. «Открыть актуальный»
открывает ту же вкладку запуска, где документ собран заново из журнала: после перепланирования там новый план, на
холсте — прежняя помеченная копия.

- [ ] **Шаг 1: падающие тесты**

`tests/orchestration-run-docs.test.mjs` (импорт расширить на `snapshotText`):

```js
test("snapshotText: the first line says it is a copy and of when; the document follows unchanged", () => {
  const got = snapshotText("# T-1 — план\n\nтекст\n", "ru", "2026-10-14T09:30:00.000Z");
  const [first, empty, ...rest] = got.split("\n");
  assert.match(first, /^> Копия документа на \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}\. Актуальный — «Открыть актуальный» на заметке или вкладка запуска\.$/);
  assert.equal(empty, "");
  assert.equal(rest.join("\n"), "# T-1 — план\n\nтекст\n");
});

test("noteText over snapshotText: the copy line survives the cut, the whole note fits NOTE_MAX", () => {
  const got = noteText(snapshotText("x".repeat(NOTE_MAX), "ru", "2026-10-14T09:30:00.000Z"), "… обрезано");
  assert.ok(got.startsWith("> Копия документа на "));
  assert.equal(got.length, NOTE_MAX);
});
```

В тест нормализатора заметок (найти `normalizeStickyNotes` в `tests/`):

```js
test("a note keeps where its snapshot came from; a bad source is dropped, the note kept", () => {
  const base = { id: "11111111-1111-4111-8111-111111111111", text: "> Копия", position: { x: 0, y: 0 }, size: { width: 300, height: 220 } };
  const source = { runId: "a0734db5-0000-4000-8000-000000000000", doc: "plan", at: "2026-10-14T09:30:00.000Z" };
  assert.deepEqual(normalizeStickyNotes([{ ...base, source }])[0].source, source);
  for (const bad of [{ ...source, doc: "summary" }, { ...source, runId: "../x" }, { ...source, at: "вчера" }, "plan", null]) {
    const [n] = normalizeStickyNotes([{ ...base, source: bad }]);
    assert.equal(n.text, "> Копия");
    assert.ok(!("source" in n), JSON.stringify(bad));
  }
});
```

Формат `id` сверить с `isInstanceId` (если он не принимает такой UUID — взять `id` из соседних тестов файла).

Run: `node --test tests/orchestration-run-docs.test.mjs tests/<файл нормализатора>` → FAIL.

- [ ] **Шаг 2: типы и нормализатор**

`contracts.ts`:

```ts
// A note that is a snapshot of a run's document (plan-result-docs.md §5): which run, which document, when it was taken.
export interface StickyNoteSource { runId: string; doc: "plan" | "result"; at: string }

export interface StickyNote extends SessionBounds {
  id: string;
  text: string;
  workspaceId?: string;
  source?: StickyNoteSource;
}
```

`SettingsStore.ts`, рядом с `workspaceField`:

```ts
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Where a snapshot note came from, or nothing: a note never loses its text over a bad source.
function noteSource(value: unknown): { source?: StickyNoteSource } {
  if (!value || typeof value !== "object") return {};
  const s = value as Partial<StickyNoteSource>;
  if (typeof s.runId !== "string" || !RUN_ID.test(s.runId) || (s.doc !== "plan" && s.doc !== "result")) return {};
  if (typeof s.at !== "string" || s.at.length > 40 || Number.isNaN(Date.parse(s.at))) return {};
  return { source: { runId: s.runId, doc: s.doc, at: s.at } };
}
```

В `normalizeStickyNotes` после `...workspaceField(source.workspaceId)`: `...noteSource(source.source)`.

Проверить: правка текста заметки (`changeStickyNoteText` в `App.tsx`) и перемещение не теряют `source` — они
копируют объект заметки (`{ ...note, text }`). Если где-то заметка собирается заново по полям — добавить `source`.

- [ ] **Шаг 3: `snapshotText`**

`runDocs.ts`:

```ts
// The first line of a snapshot on the canvas: a copy, of when, where the current one is. The time is the person's own.
export function snapshotText(markdown: string, locale: LocaleId, at: string): string {
  const time = new Date(at).toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return `> ${w(locale, "docSnapshotLine", { time })}\n\n${markdown}`;
}
```

i18n:
- `docSnapshotLine` — ru «Копия документа на {time}. Актуальный — «Открыть актуальный» на заметке или вкладка
  запуска.», en «A copy of the document as of {time}. The current one: «Open current» on the note, or the run's tab.»;
- `noteSnapshotOf` — ru «Копия документа на {time}», en «A copy of the document as of {time}»;
- `noteOpenCurrent` — ru «Открыть актуальный», en «Open current».

Если `toLocaleString("ru-RU")` в Node тестов даёт формат без запятой — подогнать регулярку теста под фактический
формат `ru-RU`, а не формат под тест.

- [ ] **Шаг 4: заметка**

`StickyNoteCard.tsx`: проп `onOpenSource?(source: StickyNoteSource): void`. Между `</header>` и `<textarea`:

```tsx
      {note.source && (
        <div className="sticky-note-card__source" data-note-source={note.source.doc}>
          <span>{t(locale, "noteSnapshotOf").replace("{time}", new Date(note.source.at).toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }))}</span>
          {onOpenSource && <button type="button" data-note-open-source onClick={() => onOpenSource(note.source!)}>{t(locale, "noteOpenCurrent")}</button>}
        </div>
      )}
```

Стиль: строка над полем, мелкий шрифт, кнопка справа; высота поля не должна вылезать за карточку (сверить с тем, как
поле заполняет карточку — grid или flex — и подогнать).

`WorkspaceCanvas.tsx`:

```tsx
  // a run document's snapshot as a note in the middle of the view (plan-result-docs.md §5): marked as a copy of when,
  // with the way back to the current one; the active workspace, like any new note
  const noteFromText = useCallback((markdown: string, from: { runId: string; doc: "plan" | "result" }): void => {
    const at = new Date().toISOString();
    const text = noteText(snapshotText(markdown, settings.locale, at), t(settings.locale, "docNoteCut"));
    onCreateStickyNote({ ...stickyNoteAtPoint(viewportCenterWorldPoint(), crypto.randomUUID()), text, source: { ...from, at } });
  }, [onCreateStickyNote, settings.locale, viewportCenterWorldPoint]);
```

Проверить, что `createNote` не ставит `workspaceId` сам, а это делает `onCreateStickyNote` в `App.tsx` (иначе
повторить то же здесь).

```tsx
<OrchestrationOverlays … onNoteFromText={noteFromText} />
```

`<StickyNoteCard … onOpenSource={(s) => openRunInWorkspace(s.runId, s.doc)} />` — `openRunInWorkspace` (~254)
принимает `tab?: PanelTab` вместо `tab?: "summary"`; `agentUi.openPanel(link.linkId, { tab })` и `openRunById` уже
принимают `PanelTab` после задачи 4.

- [ ] **Шаг 5: `OrchestrationOverlays`**

В деструктуризацию и тип пропов добавить `onNoteFromText?: (markdown: string, source: { runId: string; doc: "plan" | "result" }) => void`,
в `<RunPanel …>` — `onNoteFromText={onNoteFromText}`.

- [ ] **Шаг 6: smoke**

В `scripts/smoke-orchestration-ui.mjs`, после проверки «Копировать» из задачи 4 (открыта вкладка «План»):

```js
  const notesBefore = await app.ev(`document.querySelectorAll("[data-sticky-note-id]").length`);
  await app.clickEl(q("[data-run-doc-note]"));
  await app.waitFor(`document.querySelectorAll("[data-sticky-note-id]").length === ${notesBefore} + 1`, "a note added");
  const note = `[...document.querySelectorAll("[data-sticky-note-id]")].at(-1)`;
  const noteText = await app.ev(`${note}.querySelector("textarea").value`);
  expect(noteText.startsWith("> Копия документа на ") && noteText.includes("— план"), "«To the canvas»: a note marked as a copy of when", noteText.slice(0, 120));
  expect(await app.ev(`${note}.querySelector('[data-note-source="plan"]') !== null`), "the note shows it is a snapshot of the plan", null);
  await app.clickEl(q("[data-orch-tab='result']")); // away from the plan
  await app.clickEl(`${note}.querySelector("[data-note-open-source]")`);
  await app.waitFor(`${q('[data-run-doc="plan"]')} !== null`, "«Open current» opens the run's plan tab");
  expect(true, "«Open current» on the note opens the current plan", null);
```

Селектор вкладки (`data-orch-tab`) и язык интерфейса smoke сверить с файлом; если smoke идёт на английском — ожидать
«> A copy of the document as of » и «— plan».

Run: `npm run build && node scripts/smoke-orchestration-ui.mjs`
Expected: `"ok": true`.

- [ ] **Шаг 7: коммит**

```bash
git add src/shared/contracts.ts src/main/services/SettingsStore.ts src/renderer/src scripts/smoke-orchestration-ui.mjs tests
git commit -m "feat(orchestration): a run document's snapshot as a note, marked as a copy, with the way to the current one"
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
3. §3.3: текст созданного документа — точно из дерева запуска (`orchestration:file`), diff — запасной путь с пометкой
   «восстановлено из изменений»; «Main и IPC не меняются» заменить на новый вызов чтения.
4. §5: заметка-снимок — первая строка «Копия документа на …», плашка и «Открыть актуальный», поле `source`;
   лимит 20 000 символов вместе с хвостом (не 30 000).
5. Статус: «реализовано, на ревью».

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

Собранное приложение на **копии** профиля владельца (`ditto` в scratchpad; живой профиль и установленное приложение
не трогать, модели не вызывать — только чтение готового запуска). Завершённый запуск с созданным документом. Открыть «План»
и «Результат». В «Созданных документах» виден точный текст созданного документа без пометки
«восстановлено». «На холст» — заметка с плашкой «Копия документа на …», «Открыть актуальный» открывает вкладку. Снять
снимки обеих вкладок и заметки в `docs/ux-audit/<дата>/run-docs/`. Если копия профиля не открывает запуск (например,
main проверяет ссылки в рабочей папке проекта и что-то не сходится) — снимки на запуске smoke, и это сказать в отчёте.

- [ ] **Шаг 4: коммит**

```bash
git add docs/agent-orchestration/implementation/plan-result-docs.md docs/ux-audit
git commit -m "docs(orchestration): plan and result documents — as built"
```
