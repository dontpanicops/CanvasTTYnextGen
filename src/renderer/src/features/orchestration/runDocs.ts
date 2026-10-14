// The run's plan and result documents (docs/agent-orchestration/implementation/plan-result-docs.md): what the person
// reads in a minute, derived from the journal and the run's view — never stored, nothing in them is the agents' proof.
// One RunDoc feeds both the panel's view and the markdown (copy, a note on the canvas), so the two never differ.
import type { LocaleId } from "../../../../shared/contracts.ts";
import type { OrchestrationChanges, OrchestrationConditions, OrchestrationDiff, OrchestrationRunView, OrchestrationTake } from "../../../../shared/orchestration.ts";
import { t, type TranslationKey } from "../../lib/i18n.ts";
import { outcomeKey, reportParts, saidKey, type RunSummaryModel } from "./runStatus.ts";
import { takenLines } from "./runModel.ts";

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
const stageField = (plans: readonly PlanEntry[], n: number, field: "task" | "title"): Loaded<string> | null => {
  for (let i = plans.length - 1; i >= 0; i -= 1) {
    const p = plans[i];
    if (p.firstStage > n) continue;
    if (p.text === "loading" || p.text === "error") return p.text;
    return p.text.stages[n - p.firstStage]?.[field] ?? null;
  }
  return null;
};
export const stageTask = (plans: readonly PlanEntry[], n: number): Loaded<string> | null => stageField(plans, n, "task");

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
  if (model.stages?.length) sections.push({ heading: say("orchSum_stages"), lines: [{ kind: "text", text: say("docPlanByLead") }] });
  for (const st of model.stages ?? []) {
    const lines: DocLine[] = [{ kind: "text", text: loaded(locale, stageTask(plans, st.n)) }];
    const conds = c?.conditions.filter((x) => x.stage === st.n) ?? [];
    if (conds.length) lines.push({ kind: "text", text: say("docConditions") }, ...conds.map((x): DocLine => ({
      kind: "item", mark: x.status,
      text: `${x.id} ${x.text} — ${evidenceText(locale, x.evidence)}${x.covers.length ? `; ${say("docCovers", { ids: x.covers.join(", ") })}` : ""}`
    })));
    const state = !model.complete && st.state !== "done" ? "orchSumStage_unloaded" : saidKey(view, `orchSumStage_${st.state}`);
    sections.push({ heading: say("docStageHeading", { n: st.n, title: loaded(locale, st.title ?? stageField(plans, st.n, "title")), state: say(state) }), lines });
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
