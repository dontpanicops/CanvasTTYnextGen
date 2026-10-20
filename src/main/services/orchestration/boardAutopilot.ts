// B4: the board's autopilot of a link (stage-b-board.md §5). It does nothing the «Start» button would not do with the
// same settings: the same start on the link (a requestId kept until answered), the same readiness first (no model turn),
// «Take the result → Create a branch» when a task became «Done» (owner's decision 8), a dependent copy from that branch
// (decision 11). It answers no question and passes no right on: a permission request is a wait (§5.3).
// Whether it is on lives here only: a restart of the application turns it off.
import type { OrchestrationGoalInput, OrchestrationProjectProfile, OrchestrationReadiness, OrchestrationResult, OrchestrationTakeOutcome } from "../../../shared/orchestration.ts";
import {
  activeMs, autopilotParallelStep, autopilotStep, goalFor, isCopy,
  type AutopilotBudget, type AutopilotLimit, type BoardHead, type AutopilotState, type AutopilotStop, type AutopilotStopCode, type AutopilotWaiting, type Board,
  type LimitedRun, type RunTaskFacts
} from "../../../shared/taskBoard.ts";

type R<T> = OrchestrationResult<T>;
type Records = { ts: string; type: string; data: Record<string, unknown> }[];

export interface BoardAutopilotDeps {
  view(): Promise<{ board: Board; facts: RunTaskFacts[] }>;
  link(linkId: string): Promise<{ workspaceId: string; project: string } | null>;
  profile(project: string): Promise<OrchestrationProjectProfile>;
  optionalChecks: boolean;
  journal(runId: string): Promise<Records>;
  readiness(input: { linkId: string; commands: string[]; workMode: OrchestrationProjectProfile["workMode"]; models?: OrchestrationGoalInput["models"] }): Promise<R<OrchestrationReadiness>>;
  start(input: { linkId: string; requestId: string; goal: OrchestrationGoalInput }): Promise<R<{ runId: string }>>;
  take(runId: string): Promise<R<OrchestrationTakeOutcome>>;
  // C1 (stage-c-parallel.md §4): the board's merged head of a place with its merges, its start, a merge into it
  head(workspaceId: string, project: string): Promise<BoardHead | null>;
  ensureHead(workspaceId: string, project: string): Promise<void>;
  merge(input: { workspaceId: string; project: string; task: { id: string; key: string }; taskRunId: string; commit: string; language: "ru" | "en" }): Promise<R<{ runId: string } | { already: true }>>;
  // C3 (stage-c3-conflicts.md §9): a paused merge handed to an agent (its resolution run), or set to wait for a slot / the person
  toAgent?(mergeRunId: string, language: "ru" | "en"): Promise<R<{ runId: string }>>;
  mergeWait?(mergeRunId: string, why: "merge_waits_slot" | "merge_budget"): Promise<R<void>>;
  // C4 (stage-c4-limits.md §2): «Продолжить» of a run paused at a provider's limit; the turns a limit ended (the run's
  // feed); the resolution runs (C3) of a place paused at a limit
  resume?(runId: string): Promise<R<void>>;
  limitTurns?(runId: string): Promise<Set<string>>;
  resolutionLimits?(workspaceId: string, project: string): Promise<{ runId: string; key: string; provider: string; resetsAt: number | null }[]>;
  // E3 (stage-e-decomposition.md §7): the decomposition run of a parent (main's startDecomposition)
  decompose?(taskId: string, language: "ru" | "en"): Promise<R<{ runId: string }>>;
  newId(): string;
  now(): number;
}

interface Live {
  language: "ru" | "en";
  workspaceId: string;
  project: string;
  since: number; // when it was turned on: the merges into the head since then count in its minutes (decision 14)
  merges: Set<string>; // those merge runs, kept: a new head does not take the old one's out of the minutes
  print: string; // the profile's fingerprint when turned on
  grants: OrchestrationProjectProfile["grants"];
  started: string[];
  agents: string[]; // C3: the resolution runs it started — runs and minutes of its budget
  splits: string[]; // E3: the decomposition runs it started — runs and minutes of its budget
  refused: Set<string>; // C3: merges the application would not hand to an agent: the person's
  pending: string | null; // a start asked and not answered yet (a refusal clears it; an error turns the autopilot off)
  waits: string | null;
  // C4: its continuations of a run in a row (reset once a turn of it completes), the reset each was for
  resumes: Map<string, { n: number; reset: number | null; turns: number }>;
  limit: AutopilotLimit | null;
  resumed: { runId: string; key: string; provider: string; at: string } | null;
  busy: boolean;
}

// §5.1: the settings a start takes, and the project's saved permissions — any change turns the autopilot off
const fingerprint = (p: OrchestrationProjectProfile): string => JSON.stringify({
  access: p.access, workMode: p.workMode, models: p.models ?? null, finish: p.finish, checks: p.checks, prepare: p.prepare, env: p.env,
  grants: p.grants.map((g) => `${g.provider}:${g.kind}:${g.fingerprint}`).sort()
});

// C4: the turns of a run that completed (a run that got past its limit completed one since)
const completedTurns = (records: Records): number => records.filter((r) => r.type === "turn.finished" && r.data.outcome === "completed").length;

// A start that is refused for a while only: the link or the folder holds another run, which the autopilot waits out
const LATER = new Set(["link_busy", "folder_busy"]);

// ponytail: one timer polls every link that is on (1.5 s); a run's events would wake it sooner if it ever matters
export function createBoardAutopilot(deps: BoardAutopilotDeps, budgetOf: (linkId: string) => Promise<AutopilotBudget>, tickMs = 1500) {
  const live = new Map<string, Live>();
  const stops = new Map<string, AutopilotStop>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function off(linkId: string, code: AutopilotStopCode, detail: string | null, key: string | null, waiting?: AutopilotWaiting[]): void {
    live.delete(linkId);
    stops.set(linkId, { code, detail: detail?.slice(0, 400) ?? null, key, at: new Date(deps.now()).toISOString(), ...(waiting ? { waiting: waiting.slice(0, 20) } : {}) });
    if (!live.size && timer) { clearInterval(timer); timer = null; }
  }

  // its runs' working minutes, and (C2, owner's decision 14) the merge runs into the place's head since it was turned
  // on — its own and the person's, the updates from HEAD too: their preparation and checks, never a pause for the person
  async function used(l: Live, head?: BoardHead | null): Promise<{ runs: number; ms: number }> {
    let ms = 0;
    // C4 (§2.4): a pause at a provider's limit is a wait, not work
    for (const id of [...l.started, ...l.agents, ...l.splits]) {
      ms += activeMs(await deps.journal(id).catch(() => []), deps.now(), undefined, await deps.limitTurns?.(id).catch(() => new Set<string>()) ?? new Set());
    }
    const merges = (head === undefined ? await deps.head(l.workspaceId, l.project).catch(() => null) : head)?.merges ?? [];
    for (const m of merges) if (m.createdAt >= l.since) l.merges.add(m.runId);
    for (const id of l.merges) ms += activeMs(await deps.journal(id).catch(() => []), deps.now(), () => true);
    return { runs: l.started.length + l.agents.length + l.splits.length, ms };
  }

  // C4 (§2.2, §2.4): the runs of the place paused at a provider's limit. Its own (started, agents) it may continue; a
  // reset not later than the one it continued at last reads as unknown; a run that completed a turn since starts afresh
  async function limitedRuns(l: Live, board: Board, facts: RunTaskFacts[], at: { workspaceId: string; project: string }): Promise<LimitedRun[]> {
    const place = new Map(board.tasks.filter((t) => t.workspaceId === at.workspaceId && t.project === at.project).map((t) => [t.id, t.key]));
    // E3 (§7): its own decomposition runs too (the key is the parent's); a person's split is not the autopilot's to continue
    const parent = (f: RunTaskFacts) => f.taskId ?? (l.splits.includes(f.runId) ? f.decompositionOf ?? null : null);
    const found = facts.filter((f) => f.status === "paused" && f.providerLimit && parent(f) && place.has(parent(f)!))
      .map((f) => ({ runId: f.runId, key: place.get(parent(f)!)!, provider: f.providerLimit!.provider, resetsAt: f.providerLimit!.resetsAt }));
    found.push(...await deps.resolutionLimits?.(at.workspaceId, at.project).catch(() => []) ?? []);
    const out: LimitedRun[] = [];
    for (const f of found) {
      const own = l.started.includes(f.runId) || l.agents.includes(f.runId) || l.splits.includes(f.runId);
      let r = l.resumes.get(f.runId);
      if (r && completedTurns(await deps.journal(f.runId).catch(() => [])) > r.turns) { l.resumes.delete(f.runId); r = undefined; }
      const stale = r && f.resetsAt !== null && r.reset !== null && f.resetsAt <= r.reset;
      out.push({ ...f, resetsAt: stale ? null : f.resetsAt, own, resumes: r?.n ?? 0 });
    }
    return out;
  }

  // E4 (stage-e-decomposition.md §10): the parent's key of its latest own split that goes on (running, or proposed and
  // not yet made into subtasks); a paused one waits for the person or the limit, not "splitting"
  async function splittingOf(l: Live): Promise<string | null> {
    if (!l.splits.length) return null;
    const v = await deps.view().catch(() => null);
    for (const id of [...l.splits].reverse()) {
      const f = v?.facts.find((x) => x.runId === id);
      const t = v?.board.tasks.find((x) => x.id === f?.decompositionOf);
      if (!f || !t) continue;
      const moving = f.status === "completed" ? f.split === "proposed" && !f.splitFailed && t.decomposedBy !== id : ["preparing", "running", "pausing", "stopping"].includes(f.status);
      if (moving) return t.key;
    }
    return null;
  }

  async function tick(linkId: string): Promise<void> {
    const l = live.get(linkId);
    if (!l || l.busy) return;
    l.busy = true;
    try { await step(linkId, l); } catch (error) {
      if (live.get(linkId) === l) off(linkId, "start_failed", String((error as Error)?.message ?? error), null);
    } finally { l.busy = false; }
  }

  async function step(linkId: string, l: Live): Promise<void> {
    const at = await deps.link(linkId);
    if (!at || at.project !== l.project) return off(linkId, "link_gone", null, null);
    const profile = await deps.profile(at.project);
    const { board, facts } = await deps.view();
    if (live.get(linkId) !== l) return; // turned off meanwhile
    // C1: a separate copy goes with N slots and the board's merged head (C2: a worktree too); the project folder as in B
    const head = isCopy(profile.workMode) ? await deps.head(at.workspaceId, at.project) : null;
    const limited = await limitedRuns(l, board, facts, at);
    const now = deps.now();
    const next = isCopy(profile.workMode)
      ? autopilotParallelStep(board, facts, at, l.started, await used(l, head), await budgetOf(linkId), head, l.refused, limited, now, l.splits)
      : autopilotStep(board, facts, { ...at, workMode: profile.workMode }, l.started.at(-1) ?? null, await used(l, null), await budgetOf(linkId), limited, now, l.splits);
    l.waits = next.kind === "wait" ? next.why : null;
    l.limit = next.kind === "wait" ? next.limit ?? null : null;
    if (next.kind === "wait") return;
    if (next.kind === "resume") {
      const r = await deps.resume?.(next.runId) ?? { ok: false as const, code: "resume_unavailable", message: "" };
      // the person continued it first, or it is no longer paused: the next step sees it as it is
      if (!r.ok && (r.code === "stale_revision" || r.code === "invalid_state")) return;
      if (!r.ok) return off(linkId, "resume_failed", r.code, next.key);
      const was = l.resumes.get(next.runId);
      const turns = completedTurns(await deps.journal(next.runId).catch(() => []));
      const reset = limited.find((x) => x.runId === next.runId)?.resetsAt ?? null;
      l.resumes.set(next.runId, { n: (was?.n ?? 0) + 1, reset, turns });
      l.resumed = { runId: next.runId, key: next.key, provider: next.provider, at: new Date(deps.now()).toISOString() };
      return;
    }
    if (next.kind === "off") return off(linkId, next.code, next.detail, next.key, next.waiting);
    if (next.kind === "head") { await deps.ensureHead(at.workspaceId, at.project); return; }
    if (next.kind === "merge") {
      const r = await deps.merge({ workspaceId: at.workspaceId, project: at.project, task: { id: next.taskId, key: next.key }, taskRunId: next.runId, commit: next.commit, language: l.language });
      // another merge into this head goes on or waits for the person: the next step sees it
      if (!r.ok && r.code !== "merge_busy") return off(linkId, "merge_failed", r.code, next.key);
      return;
    }
    if (next.kind === "merge_wait") {
      const r = await deps.mergeWait?.(next.mergeRunId, next.why);
      if (r && !r.ok && r.code !== "merge_not_paused") return off(linkId, "merge_failed", r.code, next.key);
      return;
    }
    if (next.kind === "agent") {
      // the settings as when it was turned on (§6: the rights of the resolution run are the profile's, as for a task)
      if (fingerprint(profile) !== l.print) return off(linkId, "settings_changed", null, next.key);
      if (!deps.toAgent) { l.refused.add(next.mergeRunId); return; }
      const r = await deps.toAgent(next.mergeRunId, l.language);
      if (r.ok) { l.agents.push(r.value.runId); return; }
      // the application would not hand this one to an agent: it waits for the person; a merge that no longer waits: the next step sees it
      if (r.code !== "merge_not_paused") l.refused.add(next.mergeRunId);
      return;
    }
    if (next.kind === "take") {
      const r = await deps.take(next.runId);
      if (!r.ok) return off(linkId, "take_failed", r.code, next.key);
      if (!["created", "renamed", "already"].includes(r.value.result)) return off(linkId, "take_failed", r.value.result, next.key);
      return;
    }
    if (next.kind === "decompose") {
      // E3 (§7): the settings as when it was turned on, as before a start; the split stands on no link: no readiness
      if (fingerprint(profile) !== l.print) {
        const added = profile.grants.filter((g) => !l.grants.some((o) => o.id === g.id));
        return added.length ? off(linkId, "grant_added", added.map((g) => `${g.provider}: ${g.summary}`).join("; "), next.task.key)
          : off(linkId, "settings_changed", null, next.task.key);
      }
      if (!deps.decompose) return off(linkId, "decomposition_failed", "unavailable", next.task.key);
      const r = await deps.decompose(next.task.id, l.language);
      if (r.ok) { l.splits.push(r.value.runId); return; }
      // someone split or started it first, or its dependencies moved: the next step decides from the board as it is
      if (["decomposition_active", "task_active_run", "deps_not_ready"].includes(r.code)) return;
      return off(linkId, "decomposition_failed", r.code, next.task.key);
    }
    // before a start: the settings as when it was turned on, then the same readiness as the dialog's
    if (fingerprint(profile) !== l.print) {
      const added = profile.grants.filter((g) => !l.grants.some((o) => o.id === g.id));
      return added.length ? off(linkId, "grant_added", added.map((g) => `${g.provider}: ${g.summary}`).join("; "), next.task.key)
        : off(linkId, "settings_changed", null, next.task.key);
    }
    const goal = goalFor(next.task, profile, { optionalChecks: deps.optionalChecks, language: l.language, base: next.base, tasks: board.tasks });
    if (!l.pending) {
      const ready = await deps.readiness({ linkId, commands: goal.commands ?? [], workMode: profile.workMode, ...(goal.models ? { models: goal.models } : {}) });
      if (!ready.ok && LATER.has(ready.code)) { l.waits = "run"; return; }
      if (!ready.ok) return off(linkId, "not_ready", ready.code, next.task.key);
      // a blocker refuses the start; a «confirm» item needs the person's acknowledgement, which the autopilot never gives
      const stop = ready.value.items.find((i) => i.level === "blocker" || i.level === "confirm");
      if (stop && stop.id === "busy") { l.waits = "run"; return; }
      if (stop) return off(linkId, "not_ready", `${stop.id}: ${stop.detail}`, next.task.key);
      l.pending = deps.newId();
    }
    if (live.get(linkId) !== l) return;
    // ponytail: turned off while this start waits in the canvas queue, the run still starts (the person sees it on the
    // link; a new autopilot does not count or take it)
    const r = await deps.start({ linkId, requestId: l.pending, goal });
    if (!r.ok) {
      // C1: the head moved by a merge between this step and the start, or another link's autopilot took the task: the
      // next step decides again from the board as it is
      const raced = next.base?.key === "T-0" && (r.code === "invalid_base" || r.code === "task_active_run");
      if (LATER.has(r.code) || raced) { l.pending = null; l.waits = "run"; return; }
      return off(linkId, "start_failed", r.code, next.task.key);
    }
    l.pending = null;
    l.started.push(r.value.runId);
  }

  return {
    // on: from now, with the profile as it is now; off: the run that goes on goes on, no new one starts
    async set(linkId: string, on: boolean, language: "ru" | "en" = "en"): Promise<void> {
      if (!on) { live.delete(linkId); stops.delete(linkId); if (!live.size && timer) { clearInterval(timer); timer = null; } return; }
      if (live.has(linkId)) return;
      const at = await deps.link(linkId);
      if (!at) throw Object.assign(new Error("no such link"), { code: "link_not_found" });
      const profile = await deps.profile(at.project);
      live.set(linkId, { language, workspaceId: at.workspaceId, project: at.project, since: deps.now(), merges: new Set(), print: fingerprint(profile), grants: profile.grants, started: [], agents: [], splits: [], refused: new Set(), pending: null, waits: null, busy: false, resumes: new Map(), limit: null, resumed: null });
      stops.delete(linkId);
      // the first step on the next beat; the timer alone never keeps the process up
      timer ??= setInterval(() => { for (const id of live.keys()) void tick(id); }, tickMs);
      timer.unref?.();
    },
    async state(): Promise<Record<string, AutopilotState>> {
      const out: Record<string, AutopilotState> = {};
      for (const id of new Set([...live.keys(), ...stops.keys()])) {
        const l = live.get(id);
        const u = l ? await used(l) : { runs: 0, ms: 0 };
        out[id] = { on: !!l, budget: await budgetOf(id), used: { runs: u.runs, minutes: Math.floor(u.ms / 60_000) }, waits: l?.waits ?? null, stop: stops.get(id) ?? null,
          limit: l?.limit ?? null, resumed: l?.resumed ?? null, splitting: l ? await splittingOf(l) : null };
      }
      return out;
    },
    tick, // tests: one step now
    shutdown(): void { live.clear(); if (timer) { clearInterval(timer); timer = null; } }
  };
}

