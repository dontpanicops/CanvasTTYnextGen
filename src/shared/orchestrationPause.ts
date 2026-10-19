// Why a run paused: one classification for the window and for main (C4, stage-c4-limits.md §1.3). Pure.
import type { OrchestrationActivityEntry, OrchestrationRunView } from "./orchestration.ts";

// Main's reason (the journal, format v1) and, for a pause a turn's end caused, what that turn's activity adds:
// - provider_limit: a provider's usage limit ended the turn. The journal says paused(environment_error), as for any failed
//   turn; the CLI's message is in the turn's activity. The one recorded message is Codex's (codex-cli 0.155.1,
//   evidence/real-stage-13/series-S3-S5-S6-attempt2): "You’ve hit your usage limit. … try again at Sep 28th, 2026
//   11:51 PM." No real Claude limit message has been recorded, so a Claude limit still reads as an environment error.
//   The reset is the CLI's own words, not parsed.
// - model_unsupported: the provider refused the model the CLI's own config names. The journal says
//   paused(environment_error); the recorded message is Codex's HTTP 400 (codex-cli 0.155.1, evidence/real-a-gate R1):
//   "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." The model is the CLI's words.
// - ending: the step that ended the turn (TurnResult.ending, kept as detail.endStep of its turn_finished entry).
// - reason: main's reason as it is.
export type PauseCause =
  | { kind: "provider_limit"; reason: string; provider: string; resetsAt: string | null }
  | { kind: "model_unsupported"; reason: string; provider: string; model: string }
  | { kind: "prepare"; reason: string; command: string | null } // the environment preparation failed (its last record)
  | { kind: "ending"; reason: string; step: string }
  | { kind: "reason"; reason: string };
const USAGE_LIMIT = /\bhit your usage limit\b/i;
const MODEL_UNSUPPORTED = /The '([^']{1,100})' model is not supported when using Codex\b/i;

// reason: main's pause reason; turnId: the turn whose end the pause is (null: none); entries: the run's activity.
export function pauseCause(reason: string, turnId: string | null, entries: readonly OrchestrationActivityEntry[]): PauseCause {
  const turn = turnId ? entries.filter((e) => e.turnId === turnId) : [];
  const finished = [...turn].reverse().find((e) => e.kind === "turn_finished");
  if (!finished || finished.text === "completed") return { kind: "reason", reason };
  // the service's outcome -> pause reason mapping (pauseForOutcome): the pause must be this outcome's
  const mapped = finished.text === "invalid_report" ? "invalid_report"
    : finished.text === "protocol_error" || finished.text === "contract_violation" ? "protocol_error" : "environment_error";
  if (mapped !== reason) return { kind: "reason", reason };
  const limit = reason === "environment_error" ? turn.find((e) => e.kind === "error" && USAGE_LIMIT.test(e.text)) : undefined;
  if (limit) return { kind: "provider_limit", reason, provider: limit.provider ?? finished.provider ?? "provider", resetsAt: /try again at (.+?)\.?\s*$/i.exec(limit.text)?.[1] ?? null };
  const model = reason === "environment_error" ? turn.map((e) => (e.kind === "error" ? MODEL_UNSUPPORTED.exec(e.text)?.[1] : undefined)).find(Boolean) : undefined;
  if (model) return { kind: "model_unsupported", reason, provider: "codex", model };
  const step = finished.detail?.endStep;
  return typeof step === "string" && step !== "ok" ? { kind: "ending", reason, step } : { kind: "reason", reason };
}

// The turn a pause at `end` (exclusive index into entries) belongs to: the last one that finished before it, unless the
// run went on since (a status other than paused/pausing) or paused for another reason in between.
export function pausedTurn(entries: readonly OrchestrationActivityEntry[], end: number, reason: string): string | null {
  let at = end - 1;
  while (at >= 0 && entries[at].kind !== "turn_finished") at--;
  if (at < 0) return null;
  const later = entries.slice(at + 1, end).filter((x) => x.kind === "status");
  if (later.some((x) => x.detail?.status !== "paused" && x.detail?.status !== "pausing")) return null;
  if (later.some((x) => x.detail?.status === "paused" && x.detail?.reason !== reason)) return null;
  return entries[at].turnId;
}

// The cause of the run's current state (null: no reason). Only a pause is explained by a turn.
export function viewCause(view: OrchestrationRunView, entries: readonly OrchestrationActivityEntry[]): PauseCause | null {
  if (!view.reason) return null;
  if (view.status !== "paused") return { kind: "reason", reason: view.reason };
  // a failed preparation pauses the run before anything else (cycle.ts): the pause is that preparation's
  const prep = view.progress?.prepare;
  if (prep?.status === "failed" && (view.reason === "needs_user_action" || view.reason === "external_failure")) return { kind: "prepare", reason: view.reason, command: prep.command };
  return pauseCause(view.reason, pausedTurn(entries, entries.length, view.reason), entries);
}
