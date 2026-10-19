// E1 (docs/agent-orchestration/implementation/stage-e-decomposition.md §3.2): a decomposition run's journal — envelope v3
// with minReaderVersion 3 and run.created of kind «decomposition», the rules of v2, decompose turns only, the lead's answer
// as decomposition.proposed / rejected / whole, completed only with the matching answer. Pure: no CLI, no service.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { buildRecord, isDecompositionJournal, isResolutionJournal, isValidEventData, newerVersion, parseJournal } from "../src/main/services/orchestration/journal.ts";
import { createRun, openRun } from "../src/main/services/orchestration/store.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-splitj-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const T = { sha256: "a".repeat(64), bytes: 1 };
const oid = (c) => c.repeat(40);
const WS = { sourcePathSha256: "b".repeat(64), baseline: { commit: oid("1"), tree: oid("2") }, head: null };
const RUNNING = ["run.status", { status: "running", reason: null, completion: null }];
const done = (kind) => ["run.status", { status: "completed", reason: null, completion: { kind, basis: T } }];
const intent = (turnId) => ["turn.intent", { turnId, commandId: null, role: "lead", provider: "codex", mode: "structured-readonly", sessionId: null, task: T }];
const finished = (turnId) => ["turn.finished", { turnId, outcome: "completed", nextTurnAllowed: true, sessionId: null, contract: { status: "verified", errors: [] },
  report: { status: "valid", ref: T, storeError: null }, transport: { outcome: "completed", exitCode: 0, signal: null, groupCleared: true } }];
const turn = (turnId, purpose = "decompose") => ["orch.turn", { turnId, purpose, stage: null, round: null, planVersion: null, clarificationVersion: 0, tree: null }];
const full = (id) => [turn(id), intent(id), finished(id)];
const HEAD = (kind) => [["run.created", { goal: T, kind }], ["workspace.created", WS], RUNNING];

function lines(runId, events, version = 3, head = { minReaderVersion: 3 }) {
  let prev = null;
  return Buffer.concat(events.map(([type, data], i) => {
    const { record, line } = buildRecord(prev, runId, `2026-10-19T10:00:${String(i).padStart(2, "0")}.000Z`, type, data, version, i === 0 ? head : null);
    prev = record;
    return line;
  }));
}
const parse = (events, kind = "decomposition") => { const runId = randomUUID(); return parseJournal(lines(runId, [...HEAD(kind), ...events]), runId); };
const code = (p) => (p.integrity.status === "corrupt" ? p.integrity.detail.code : p.integrity.status);

test("a decomposition run written by the store: every line v3, the first with minReaderVersion 3 and kind decomposition; replayed by the rules of v2", async () => {
  const root = path.join(TMP, "write");
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "{}", kind: "decomposition" });
  await w.recordWorkspaceCreated(WS);
  await w.setRunStatus("running", null);
  const id = randomUUID();
  await w.recordOrchTurn({ turnId: id, purpose: "decompose", stage: null, round: null, planVersion: null, clarificationVersion: 0, tree: null });
  await w.close();
  const buf = fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"));
  const recs = buf.toString().trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(recs.every((r) => r.v === 3));
  assert.equal(recs[0].minReaderVersion, 3);
  assert.equal(recs[0].data.kind, "decomposition");
  assert.ok(isDecompositionJournal(buf));
  assert.equal(isResolutionJournal(buf), false, "isResolutionJournal keeps its meaning");
  assert.equal(newerVersion(buf), null, "this build's own");
  const p = parseJournal(buf, runId);
  assert.equal(p.integrity.status, "ok");
  assert.deepEqual([p.state.version, p.state.envelope, p.state.kind], [2, 3, "decomposition"]);
  assert.deepEqual(p.state.orch.split, { proposed: null, whole: null, rejected: [] });
  // reopened, the writer goes on in v3
  const w2 = await openRun(root, runId);
  await w2.setRunStatus("paused", "user_request");
  await w2.close();
  assert.equal(parseJournal(fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl")), runId).integrity.status, "ok");
});

test("older readers: a decomposition journal is a newer version for 1.5.19 and 1.5.7", () => {
  const runId = randomUUID();
  const buf = lines(runId, HEAD("decomposition"));
  assert.equal(newerVersion(buf, 1), 3);
  const old = parseJournal(buf, runId, { maxVersion: 1, readerVersion: 1 });
  assert.equal(old.integrity.status, "newer_version");
  assert.equal(old.state, null);
});

test("every record written and replayed: proposed, rejected twice, whole, each in its turn", () => {
  const a = randomUUID(), b = randomUUID();
  const p = parse([...full(a), ["decomposition.proposed", { turnId: a, proposal: T }], done("proposed")]);
  assert.equal(p.integrity.status, "ok", JSON.stringify(p.integrity));
  assert.equal(p.state.completion.kind, "proposed");
  assert.equal(p.state.orch.split.proposed.turnId, a);
  const r = parse([...full(a), ["decomposition.rejected", { turnId: a, reasons: T }], ...full(b), ["decomposition.rejected", { turnId: b, reasons: T }], done("rejected")]);
  assert.equal(r.integrity.status, "ok", JSON.stringify(r.integrity));
  assert.deepEqual(r.state.orch.split.rejected.map((x) => x.turnId), [a, b]);
  const afterOne = parse([...full(a), ["decomposition.rejected", { turnId: a, reasons: T }], ...full(b), ["decomposition.proposed", { turnId: b, proposal: T }], done("proposed")]);
  assert.equal(afterOne.integrity.status, "ok", "proposed after one refusal");
  const w = parse([...full(a), ["decomposition.whole", { turnId: a, why: T }], done("whole")]);
  assert.equal(w.integrity.status, "ok", JSON.stringify(w.integrity));
  assert.equal(w.state.orch.split.whole.turnId, a);
});

test("the records exist only in a decomposition journal: a resolution or v2 journal refuses them", () => {
  const a = randomUUID();
  assert.equal(code(parse([...full(a), ["decomposition.proposed", { turnId: a, proposal: T }]], "resolution")), "replay_conflict", "turn of another purpose too");
  // v2: no such record at all
  assert.equal(isValidEventData("decomposition.proposed", { turnId: a, proposal: T }, 2), false);
  assert.equal(isValidEventData("decomposition.proposed", { turnId: a, proposal: T }, 3), true);
  const runId = randomUUID();
  const v2 = lines(runId, [["run.created", { goal: T }], ["workspace.created", WS], RUNNING, turn(a, "plan"), ["decomposition.whole", { turnId: a, why: T }]], 2, { minReaderVersion: 2 });
  assert.equal(parseJournal(v2, runId).integrity.status, "corrupt");
});

test("only decompose turns in a decomposition journal, and decompose turns only there", () => {
  const a = randomUUID();
  assert.equal(code(parse([turn(a, "plan")])), "replay_conflict");
  assert.equal(code(parse([turn(a, "execute")])), "invalid_event", "an execute turn without its stage is no record at all");
  assert.equal(code(parse([turn(a)], "resolution")), "replay_conflict", "a decompose turn in a resolution journal");
  assert.equal(parse([turn(a)]).integrity.status, "ok");
});

test("an answer needs a completed decompose turn that is the last, once", () => {
  const a = randomUUID(), b = randomUUID();
  const proposed = (id) => ["decomposition.proposed", { turnId: id, proposal: T }];
  assert.equal(code(parse([turn(a), intent(a), proposed(a)])), "replay_conflict", "the turn did not complete");
  assert.equal(code(parse([...full(a), ...full(b), proposed(a)])), "replay_conflict", "not the last turn");
  assert.equal(code(parse([...full(a), proposed(a), ["decomposition.whole", { turnId: a, why: T }]])), "replay_conflict", "two answers of a turn");
  assert.equal(code(parse([...full(a), ["decomposition.rejected", { turnId: a, reasons: T }], ["decomposition.rejected", { turnId: a, reasons: T }]])), "replay_conflict");
  assert.equal(code(parse([proposed(randomUUID())])), "replay_conflict", "an unknown turn");
});

test("completed: proposed, whole, rejected only as the last turn's answer says; every other kind or combination conflicts", () => {
  const a = randomUUID(), b = randomUUID();
  const rej = (id) => ["decomposition.rejected", { turnId: id, reasons: T }];
  // no answer
  for (const kind of ["proposed", "whole", "rejected"]) assert.equal(code(parse([...full(a), done(kind)])), "replay_conflict", `${kind} without an answer`);
  // another answer than the kind
  assert.equal(code(parse([...full(a), ["decomposition.proposed", { turnId: a, proposal: T }], done("whole")])), "replay_conflict");
  assert.equal(code(parse([...full(a), ["decomposition.whole", { turnId: a, why: T }], done("proposed")])), "replay_conflict");
  // rejected once is not enough
  assert.equal(code(parse([...full(a), rej(a), done("rejected")])), "replay_conflict");
  // an earlier turn's answer, a later turn without its own
  assert.equal(code(parse([...full(a), ["decomposition.proposed", { turnId: a, proposal: T }], ...full(b), done("proposed")])), "replay_conflict");
  assert.equal(code(parse([...full(a), rej(a), ...full(b), done("rejected")])), "replay_conflict", "the last turn has no refusal");
  // the checks' kinds are no completion of this journal
  for (const kind of ["confirmed", "no_checks"]) assert.equal(code(parse([...full(a), ["decomposition.proposed", { turnId: a, proposal: T }], done(kind)])), "replay_conflict", kind);
  // no turn at all
  assert.equal(code(parse([done("whole")])), "replay_conflict");
  // a v2 completion kind of this journal in a resolution one
  assert.equal(code(parse([...full(randomUUID()), done("proposed")], "resolution")), "replay_conflict");
});
