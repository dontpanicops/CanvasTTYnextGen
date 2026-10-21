// F1 (docs/agent-orchestration/implementation/stage-f-external-projects.md §5): a board-tasks/v1 file, read and checked
// here row by row; what passes is written by the store in one write against the board as it is then (boardStore
// importTasks). Nothing here writes, starts, accepts or merges anything: only «Import» writes tasks (principle 8).
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { EXTERNAL_CRITERION, type ImportReport, type InboxTask } from "../../../shared/taskBoard.ts";
import { isModels, REF, WORKSPACE_ID, type ImportJob, type ImportRow, type ImportRows } from "./boardStore.ts";

export const IMPORT_MAX_BYTES = 1024 * 1024;
const TOP = new Set(["format", "workspaceId", "workspace", "source", "tasks"]);
const FIELDS = new Set(["ref", "project", "title", "text", "criteria", "dependsOn", "ifAbsent", "external", "models"]);
// known fields of later stages: refused row by row until their stage is in (§5.1); F2 takes external and models
const LATER: Record<string, string> = { issue: "F3", commitTitle: "F3", scope: "F4" };

// the open workspaces: by id (the check of workspaceOk) and by name (their title)
export interface ImportWorkspaces { open(id: string): boolean; named(title: string): string[] }

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const NONE: ImportRows = { created: [], updated: [], unchanged: [], refused: [] };
export function importReport(file: string, sha: string, status: ImportReport["status"], workspaceId: string | null, rows: ImportRows = NONE, code: string | null = null): ImportReport {
  return { format: "board-tasks-report/v1", file, sha256: sha, at: new Date().toISOString(), status, code, workspaceId, ...rows };
}
// a refusal of the whole file: in `code`, and as the one refused row with ref null
export const fileRefusal = (file: string, sha: string, code: string, detail: string, workspaceId: string | null = null): ImportReport =>
  importReport(file, sha, code === "invalid_file" ? "invalid_file" : "refused", workspaceId, { ...NONE, refused: [{ ref: null, code, detail: detail.slice(0, 400) }] }, code);

// ponytail: a git root is a folder with its own .git — a folder with HEAD, or a file whose first line is `gitdir: …`
// (a worktree, a submodule); no git run for it
async function gitRoot(project: unknown): Promise<string | null> {
  if (typeof project !== "string" || !project.startsWith("/") || project.length > 4096) return null;
  const real = await realpath(project).catch(() => null);
  if (!real || !(await stat(real).catch(() => null))?.isDirectory()) return null;
  const git = join(real, ".git");
  const st = await stat(git).catch(() => null);
  if (st?.isDirectory()) return (await stat(join(git, "HEAD")).catch(() => null))?.isFile() ? real : null;
  if (!st?.isFile()) return null;
  const fh = await open(git, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return /^gitdir: \S/.test(buf.subarray(0, bytesRead).toString("utf8")) ? real : null;
  } finally { await fh.close(); }
}

const refusedRow = (ref: string | null, code: string, detail: string): ImportRow => ({ ref, input: null, deps: [], ifAbsent: false, refused: { code, detail } });

// file: the file's name (for the report and origin). A file-level refusal comes back as its report
export async function readTasksFile(file: string, bytes: Uint8Array, ws: ImportWorkspaces): Promise<{ job: ImportJob } | { report: ImportReport }> {
  const sha = sha256(bytes);
  const bad = (detail: string) => ({ report: fileRefusal(file, sha, "invalid_file", detail) });
  if (bytes.length > IMPORT_MAX_BYTES) return bad("the file is over 1 MB");
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return bad("not UTF-8 JSON"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return bad("not a JSON object");
  const extra = Object.keys(doc).find((k) => !TOP.has(k));
  if (extra !== undefined) return bad(`unknown field ${extra}`);
  if (doc.format !== "board-tasks/v1") return bad("format must be board-tasks/v1");
  if ((doc.workspaceId === undefined) === (doc.workspace === undefined)) return bad("one of workspaceId and workspace");
  if (doc.workspaceId !== undefined && (typeof doc.workspaceId !== "string" || !WORKSPACE_ID.test(doc.workspaceId))) return bad("workspaceId");
  if (doc.workspace !== undefined && (typeof doc.workspace !== "string" || doc.workspace.length < 1 || doc.workspace.length > 200)) return bad("workspace: 1..200 characters");
  if (doc.source !== undefined && (typeof doc.source !== "string" || doc.source.length > 300)) return bad("source: up to 300 characters");
  if (!Array.isArray(doc.tasks) || doc.tasks.length < 1 || doc.tasks.length > 200) return bad("tasks: 1..200");

  let workspaceId: string;
  if (typeof doc.workspaceId === "string") {
    if (!ws.open(doc.workspaceId)) return { report: fileRefusal(file, sha, "workspace_unavailable", "no such open workspace", doc.workspaceId) };
    workspaceId = doc.workspaceId;
  } else {
    const ids = ws.named(doc.workspace as string);
    if (ids.length !== 1) return { report: fileRefusal(file, sha, ids.length ? "workspace_ambiguous" : "workspace_not_found", `${ids.length || "no"} open workspaces are named ${doc.workspace}`) };
    workspaceId = ids[0];
  }

  const tasks = doc.tasks as unknown[];
  const refs = tasks.map((t) => ((t as { ref?: unknown })?.ref));
  const rows: ImportRow[] = [];
  for (const [i, t] of tasks.entries()) {
    const o = t as Record<string, unknown>;
    const ref = typeof o?.ref === "string" && REF.test(o.ref) ? o.ref : null;
    const no = (code: string, detail: string) => rows.push(refusedRow(ref, code, `tasks[${i}]: ${detail}`));
    if (!o || typeof o !== "object" || Array.isArray(o)) { no("invalid_task", "not an object"); continue; }
    if (!ref) { no("invalid_ref", "ref: ^[A-Za-z0-9][A-Za-z0-9-]{0,31}$"); continue; }
    if (refs.filter((r) => r === ref).length > 1) { no("duplicate_ref", `ref ${ref} is in the file more than once`); continue; }
    const unknown = Object.keys(o).find((k) => !FIELDS.has(k) && !Object.hasOwn(LATER, k));
    if (unknown !== undefined) { no("invalid_task", `unknown field ${unknown}`); continue; }
    const later = Object.keys(o).find((k) => Object.hasOwn(LATER, k));
    if (later !== undefined) { no("field_not_supported", `${later} is taken from stage ${LATER[later]}`); continue; }
    if (o.ifAbsent !== undefined && o.ifAbsent !== true) { no("invalid_task", "ifAbsent: true or absent"); continue; }
    const deps = o.dependsOn ?? [];
    if (!Array.isArray(deps) || deps.length > 64 || !deps.every((d) => typeof d === "string" && REF.test(d)) || new Set(deps).size !== deps.length) {
      no("invalid_task", "dependsOn: up to 64 distinct refs"); continue;
    }
    if (o.external !== undefined && o.external !== true) { no("invalid_task", "external: true or absent"); continue; }
    // T-4: strings by SAFE_MODEL, as a goal's models; null is not taken (no key: the profile's model)
    if (o.models !== undefined && !(isModels(o.models) || (o.models && typeof o.models === "object" && !Array.isArray(o.models) && Object.keys(o.models).length === 0))) {
      no("invalid_task", "models: {lead?, executor?, reviewer?} of model names (no null)"); continue;
    }
    // T-10: the requirements come from the project's plan; Loom does not make them up. T-3: an external task without
    // them gets Loom's one line (a build before F2 needs ≥1 requirement)
    const none = o.criteria === undefined || (Array.isArray(o.criteria) && o.criteria.length === 0);
    if (none && o.external !== true) { no("no_criteria", "criteria: the task has none"); continue; }
    const project = await gitRoot(o.project);
    if (!project) { no("project_not_found", "project: an absolute path of an existing git repository's root"); continue; }
    const models = isModels(o.models) ? o.models : undefined;
    rows.push({ ref, ifAbsent: o.ifAbsent === true, deps: deps as string[],
      input: { workspaceId, project, title: o.title as string, text: o.text as string, criteria: none ? [EXTERNAL_CRITERION] : o.criteria as string[] },
      fields: { ...(o.external === true ? { external: true as const } : {}), ...(models ? { models: { ...models } } : {}) } });
  }
  return { job: { workspaceId, origin: { kind: "import", source: (doc.source as string | undefined) ?? null, file: file.slice(0, 255), sha256: sha }, rows } };
}

// T-2 (§5.4): a file of the import (the dialog's choice, a file of inbox/) opened with O_NOFOLLOW — a symbolic link is
// not opened, so its target is never read — and its size by fstat of what was opened (no lstat → read race).
// O_NONBLOCK: a FIFO named *.json does not hang the poll. name: the file's name for the report
export async function readImportFile(path: string, name: string): Promise<{ bytes: Uint8Array } | { report: ImportReport }> {
  const none = sha256(new Uint8Array());
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ELOOP" || e.code === "EMLINK") return null;
    throw e;
  });
  if (!fh) return { report: fileRefusal(name, none, "invalid_file", "symlink") };
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { report: fileRefusal(name, none, "invalid_file", "not a regular file") };
    if (st.size <= IMPORT_MAX_BYTES) return { bytes: await fh.readFile() };
    // over 1 MB: refused unread, its hash taken piece by piece
    const hash = createHash("sha256");
    const buf = Buffer.alloc(1 << 16);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      hash.update(buf.subarray(0, bytesRead));
    }
    return { report: fileRefusal(name, hash.digest("hex"), "invalid_file", "the file is over 1 MB") };
  } finally { await fh.close(); }
}

// the rows of a file as written there, for the window's list of an inbox/ file (nothing is checked here)
export function inboxTasks(bytes: Uint8Array): InboxTask[] {
  let doc: { tasks?: unknown };
  try { doc = JSON.parse(new TextDecoder().decode(bytes)); } catch { return []; }
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  return Array.isArray(doc?.tasks) ? doc.tasks.slice(0, 200).map((t: Record<string, unknown> | null) => ({
    ref: s(t?.ref, 32), title: s(t?.title, 200), project: s(t?.project, 4096),
    dependsOn: Array.isArray(t?.dependsOn) ? t.dependsOn.slice(0, 64).map((d) => s(d, 32)) : [], external: t?.external === true
  })) : [];
}
