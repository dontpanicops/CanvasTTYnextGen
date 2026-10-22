// Stage 13: the project profile — the one-time setup of a project for orchestrated runs, saved per project in the
// application's data (never in the project or a global configuration). Filled from facts of the repository; the user
// corrects it. It also keeps the permission decisions the person saved for this project (grants): applied only to the
// same provider, tool and parameters, never to another project.
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { OrchestrationGrant, OrchestrationProjectProfile, OrchestrationRoleModels } from "../../../shared/orchestration.ts";
import { DEFAULT_ACCESS, isClaudeAccess, isCodexAccess } from "./access.ts";
import { canonical } from "./journal.ts";
import { suggestPrepare } from "./prepare.ts";
import { SAFE_MODEL } from "./providers.ts";
import { suggestCommands } from "./readiness.ts";

const run = promisify(execFile);

export class ProfileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = "ProfileError"; }
}
const bad = (m: string): never => { throw new ProfileError("invalid_profile", m); };

const line = (v: unknown, what: string, max = 1000): string => {
  if (typeof v !== "string" || v.trim() === "" || v.length > max || v.includes("\0") || /[\r\n]/.test(v)) bad(`${what}: one line of 1..${max} characters`);
  return (v as string).trim();
};
const REL = /^(?![/~])(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]{1,300}$/; // a path inside the work folder
const GIT_NAME = /^(?!-)[A-Za-z0-9._/-]{1,200}$/; // a remote or branch name, never an option
const MAX_GRANTS = 200;
// F3 (T-6): a branch name the application writes — checkFinish's rule (GIT_NAME, no ".."); git's own check-ref-format
// --branch is asked where git is (saveProfile, the start)
export const gitNameOk = (name: string): boolean => GIT_NAME.test(name) && !name.includes("..");

// F3 (T-6): the profile's branch template of a board task's worktree branch. {ref} of a task without one is its key
export const BRANCH_FIELDS: readonly string[] = ["issue", "ref", "run8"];
export const templateFields = (template: string): string[] => [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
export const templateNeedsIssue = (template: string | undefined): boolean => !!template && templateFields(template).includes("issue");
export const fillBranch = (template: string, v: { issue: string; ref: string; run8: string }): string =>
  template.replace(/\{(issue|ref|run8)\}/g, (_, f: "issue" | "ref" | "run8") => v[f]);
// the values a template is tried with when the profile is saved (the literal part is what can be wrong)
export const PROBE_FIELDS = { issue: "ISSUE-1", ref: "T1", run8: "0123abcd" };

export function validateProfile(input: unknown): OrchestrationProjectProfile {
  const p = input as Partial<OrchestrationProjectProfile> | null;
  if (!p || typeof p !== "object") bad("profile must be an object");
  if (p!.workMode !== "project" && p!.workMode !== "worktree" && p!.workMode !== "copy") bad("workMode must be copy, worktree or project");
  if (!Array.isArray(p!.checks) || p!.checks.length > 16) bad("checks: up to 16 command lines");
  const checks = p!.checks!.map((c, i) => line(c, `check ${i + 1}`));
  const prep = p!.prepare;
  if (!prep || !Array.isArray(prep.steps) || prep.steps.length > 12 || typeof prep.auto !== "boolean") bad("prepare: {steps (up to 12), auto}");
  const steps = prep!.steps.map((s, i) => {
    if (!s || typeof s !== "object") bad(`prepare step ${i + 1}`);
    const unless = s.unless === null || s.unless === undefined || s.unless === "" ? null : String(s.unless);
    if (unless !== null && !REL.test(unless)) bad(`prepare step ${i + 1}: "unless" must be a path inside the work folder`);
    return { command: line(s.command, `prepare step ${i + 1}`), unless };
  });
  if (!p!.env || typeof p!.env.direnv !== "boolean") bad("env: {direnv}");
  const access = p!.access ?? DEFAULT_ACCESS;
  if (!isClaudeAccess(access.claude) || !isCodexAccess(access.codex)) bad("access: unknown mode");
  const models = validModels(p!.models);
  const f = p!.finish;
  if (!f || typeof f.commit !== "boolean") bad("finish: {commit, push, qa}");
  let push = null;
  if (f!.push) {
    if (!GIT_NAME.test(String(f!.push.remote)) || !GIT_NAME.test(String(f!.push.branch)) || String(f!.push.branch).includes("..")) bad("push: remote and branch names");
    push = { remote: f!.push.remote, branch: f!.push.branch, remoteUrl: typeof f!.push.remoteUrl === "string" ? f!.push.remoteUrl.slice(0, 500) : null };
    if (!f!.commit) bad("push needs the commit action");
  }
  let qa = null;
  if (f!.qa) {
    const rv = f!.qa.reportsVersion ?? false;
    if (typeof rv !== "boolean") bad("QA reportsVersion must be true or false");
    qa = { environment: line(f!.qa.environment, "QA environment", 100), command: line(f!.qa.command, "QA command"), verify: line(f!.qa.verify, "QA verification"), reportsVersion: rv };
    if (!f!.commit) bad("QA needs the commit action");
  }
  if (!Array.isArray(p!.grants) || p!.grants.length > MAX_GRANTS) bad(`grants: up to ${MAX_GRANTS}`);
  const grants = p!.grants!.map(validGrant);
  const branchTemplate = validTemplate(p!.branchTemplate, p!.workMode!);
  const runBase = validRunBase(p!.runBase, p!.workMode!);
  return {
    v: 1, workMode: p!.workMode!, checks, prepare: { steps, auto: prep!.auto }, env: { direnv: p!.env!.direnv },
    access: { claude: access.claude, codex: access.codex }, ...(models ? { models } : {}), finish: { commit: f!.commit, push, qa }, grants,
    savedAt: typeof p!.savedAt === "string" ? p!.savedAt : null,
    ...(branchTemplate ? { branchTemplate } : {}), ...(runBase ? { runBase } : {})
  };
}

// F3 (T-6): absent, null or "" — none. Worktree only; known substitutions only; {ref} or {run8} in it; the name it makes
// passes the application's rule with the probe values (git's check-ref-format: saveProfile)
function validTemplate(t: unknown, workMode: OrchestrationProjectProfile["workMode"]): string | null {
  if (t === undefined || t === null || t === "") return null;
  const no = (code: string, m: string): never => { throw new ProfileError(code, m); };
  if (workMode !== "worktree") no("work_mode_not_worktree", "branchTemplate: the worktree mode only");
  if (typeof t !== "string" || t.length > 200) no("branch_template_invalid", "branchTemplate: up to 200 characters");
  const template = t as string;
  const unknown = templateFields(template).find((f) => !BRANCH_FIELDS.includes(f));
  if (unknown !== undefined) no("branch_template_unknown", `branchTemplate: unknown substitution: {${unknown}}`);
  if (!templateFields(template).some((f) => f === "ref" || f === "run8")) no("branch_template_invalid", "branchTemplate needs {ref} or {run8}");
  if (/[^A-Za-z0-9._/-]/.test(template.replace(/\{(issue|ref|run8)\}/g, "")) || !gitNameOk(fillBranch(template, PROBE_FIELDS))) {
    no("branch_template_invalid", "branchTemplate: letters, digits and . _ / - besides the substitutions");
  }
  return template;
}

// F3 (T-13a): absent or null — none. Worktree only (remote_base_mode); remoteUrl is main's (saveProfile reads it)
function validRunBase(r: unknown, workMode: OrchestrationProjectProfile["workMode"]): OrchestrationProjectProfile["runBase"] | null {
  if (r === undefined || r === null) return null;
  const o = r as Record<string, unknown>;
  if (typeof o !== "object" || Array.isArray(o) || typeof o.remote !== "string" || typeof o.branch !== "string" || !gitNameOk(o.remote) || !gitNameOk(o.branch)) bad("runBase: remote and branch names");
  if (workMode !== "worktree") throw new ProfileError("remote_base_mode", "runBase: the worktree mode only");
  return { remote: o.remote as string, branch: o.branch as string, remoteUrl: typeof o.remoteUrl === "string" ? o.remoteUrl.slice(0, 500) : null };
}

// The model of each role (null: as in the CLI). Absent, or every role as in the CLI, is not kept.
export function validModels(m: unknown): OrchestrationRoleModels | null {
  if (m === undefined || m === null) return null;
  if (typeof m !== "object" || Array.isArray(m)) bad("models: {lead, executor, reviewer}");
  const r = m as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== "lead" && k !== "executor" && k !== "reviewer")) bad("models: {lead, executor, reviewer}");
  const one = (k: string): string | null => {
    const v = r[k] ?? null;
    if (v !== null && (typeof v !== "string" || !SAFE_MODEL.test(v))) bad(`models.${k}: model name is not allowed`);
    return v as string | null;
  };
  const out = { lead: one("lead"), executor: one("executor"), reviewer: one("reviewer") };
  return out.lead || out.executor || out.reviewer ? out : null;
}

function validGrant(g: unknown): OrchestrationGrant {
  const x = g as OrchestrationGrant;
  if (!x || typeof x !== "object" || typeof x.id !== "string" || (x.provider !== "codex" && x.provider !== "claude")
    || typeof x.kind !== "string" || typeof x.tool !== "string" || typeof x.summary !== "string"
    || !/^[0-9a-f]{64}$/.test(String(x.fingerprint)) || typeof x.grantedAt !== "string") bad("grant");
  return { id: x.id.slice(0, 64), provider: x.provider, kind: x.kind.slice(0, 40), tool: x.tool.slice(0, 120), summary: x.summary.slice(0, 600), fingerprint: x.fingerprint, grantedAt: x.grantedAt.slice(0, 40) };
}

// ---------- facts ----------

export async function gitRemotes(gitPath: string, project: string): Promise<{ name: string; url: string }[]> {
  const out = await run(gitPath, ["-C", project, "config", "--get-regexp", "^remote\\..*\\.url$"], { timeout: 10_000 }).then((r) => r.stdout, () => "");
  return out.split("\n").filter(Boolean).map((l) => {
    const sp = l.indexOf(" ");
    return { name: l.slice("remote.".length, sp - ".url".length), url: l.slice(sp + 1) };
  });
}

export async function currentBranch(gitPath: string, project: string): Promise<string | null> {
  return run(gitPath, ["-C", project, "symbolic-ref", "--short", "-q", "HEAD"], { timeout: 10_000 }).then((r) => r.stdout.trim() || null, () => null);
}

export async function suggestProfile(project: string): Promise<OrchestrationProjectProfile> {
  const s = await suggestCommands(project);
  return {
    v: 1, workMode: "copy", checks: s.commands, prepare: { steps: await suggestPrepare(project), auto: true },
    env: { direnv: true }, access: { ...DEFAULT_ACCESS }, finish: { commit: false, push: null, qa: null }, grants: [], savedAt: null
  };
}

// ---------- grants ----------

// The same action: provider, kind, tool and its parameters, without the ids, times and wording a CLI puts around a
// request. Only at the top level of the request: inside a tool's own input a "description" or "reason" is a parameter.
const VOLATILE = new Set(["threadId", "turnId", "itemId", "callId", "approvalId", "requestId", "tool_use_id", "toolUseId", "startedAtMs", "description", "reason", "_meta"]);
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => [k, stable(x)]));
  return typeof v === "number" && !Number.isFinite(v) ? null : v;
}
function stableTop(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return stable(v);
  return stable(Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !VOLATILE.has(k))));
}
export function grantFingerprint(provider: string, kind: string, tool: string, input: unknown): string {
  let body: string;
  try { body = canonical({ provider, kind, tool, input: stableTop(input ?? null) }); } catch { body = JSON.stringify({ provider, kind, tool, input: String(input) }); }
  return createHash("sha256").update(body).digest("hex");
}

// ---------- store ----------

export function createProfileStore(root: string) {
  if (!isAbsolute(root)) throw new ProfileError("invalid_input", "root must be absolute");
  const dir = join(root, "profiles");
  const file = (project: string) => join(dir, `${createHash("sha256").update(project).digest("hex")}.json`);
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => { const next = chain.then(fn); chain = next.catch(() => {}); return next; };

  async function read(project: string): Promise<OrchestrationProjectProfile | null> {
    const raw = await readFile(file(project), "utf8").catch(() => null);
    if (raw === null) return null;
    try {
      const v = JSON.parse(raw) as { project?: string; profile?: unknown };
      if (v.project !== project) return null; // another project's file under a colliding name: never used
      return validateProfile(v.profile);
    } catch {
      return null; // unreadable: the suggestion is shown again, the file stays for inspection
    }
  }
  async function write(project: string, profile: OrchestrationProjectProfile): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file(project)}.${randomUUID()}.tmp`;
    const fh = await open(tmp, "wx", 0o600);
    try { await fh.writeFile(JSON.stringify({ v: 1, project, profile })); await fh.sync(); } finally { await fh.close(); }
    await rename(tmp, file(project));
  }
  return {
    get: (project: string) => read(project),
    save: (project: string, input: unknown, now = new Date()) => serial(async () => {
      const profile = { ...validateProfile(input), savedAt: now.toISOString() };
      await write(project, profile);
      return profile;
    }),
    addGrant: (project: string, grant: Omit<OrchestrationGrant, "id" | "grantedAt">, now = new Date()) => serial(async () => {
      const profile = await read(project);
      if (!profile) throw new ProfileError("no_profile", "the project has no saved profile");
      if (profile.grants.some((g) => g.fingerprint === grant.fingerprint)) return profile;
      const next = { ...profile, grants: [...profile.grants, { ...grant, id: randomUUID(), grantedAt: now.toISOString() }].slice(-MAX_GRANTS) };
      await write(project, next);
      return next;
    })
  };
}
export type ProfileStore = ReturnType<typeof createProfileStore>;
