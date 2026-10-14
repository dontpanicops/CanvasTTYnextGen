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
