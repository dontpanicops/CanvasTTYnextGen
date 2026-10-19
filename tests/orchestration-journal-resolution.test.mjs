// C3 (docs/agent-orchestration/implementation/stage-c3-conflicts.md §7.2): a resolution run's journal — envelope v3 with
// minReaderVersion 3, the rules of v2, run.created of kind «resolution», the application's plan. This build replays it;
// a reader of 1.5.19 (maxVersion 2 without this kind, read as a newer journal) and of 1.5.7 do not. Pure: no CLI, no service.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { RESOLUTION_VERSION, buildRecord, isResolutionJournal, isValidEventData, newerVersion, parseJournal } from "../src/main/services/orchestration/journal.ts";
import { createRun, openRun } from "../src/main/services/orchestration/store.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-resj-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const T = { sha256: "a".repeat(64), bytes: 1 };
const oid = (c) => c.repeat(40);
const WS = { sourcePathSha256: "b".repeat(64), baseline: { commit: oid("1"), tree: oid("2") }, head: null };
const APP_PLAN = { by: "app", version: 1, plan: T, firstStage: 1, stageCount: 1, conditionsAssigned: 2 };

function lines(runId, events, version = 3, head = { minReaderVersion: 3 }) {
  let prev = null;
  return Buffer.concat(events.map(([type, data], i) => {
    const { record, line } = buildRecord(prev, runId, `2026-10-19T10:00:0${i}.000Z`, type, data, version, i === 0 ? head : null);
    prev = record;
    return line;
  }));
}

test("a resolution run written by the store: every line v3, the first with minReaderVersion 3 and its kind; replayed by the rules of v2 with the application's plan", async () => {
  const root = path.join(TMP, "write");
  const runId = randomUUID();
  const w = await createRun(root, runId, { goal: "{}", kind: "resolution" });
  await w.recordWorkspaceCreated(WS);
  await w.recordAppPlan({ plan: await w.putText("{}"), stageCount: 1, conditionsAssigned: 2 });
  await w.setRunStatus("running", null);
  await w.close();
  const buf = fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"));
  const recs = buf.toString().trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((r) => r.v), [3, 3, 3, 3]);
  assert.equal(recs[0].minReaderVersion, 3);
  assert.deepEqual(Object.keys(recs[0].data).sort(), ["goal", "kind"]);
  assert.equal(recs[0].data.kind, "resolution");
  assert.ok(recs.slice(1).every((r) => !("minReaderVersion" in r)));
  assert.deepEqual(recs[3].data, { status: "running", reason: null, completion: null }, "run.status of v2's rules");
  assert.ok(isResolutionJournal(buf));
  assert.equal(newerVersion(buf), null, "this build's own");
  const p = parseJournal(buf, runId);
  assert.equal(p.integrity.status, "ok");
  assert.deepEqual([p.state.version, p.state.envelope], [2, 3]);
  assert.deepEqual([p.state.orch.plan.turnId, p.state.orch.plan.version, p.state.orch.plan.base, p.state.orch.nextCondition], [null, 1, 1, 3]);
  // reopened, the writer goes on in v3
  const w2 = await openRun(root, runId);
  await w2.setRunStatus("paused", "user_request");
  await w2.close();
  const last = JSON.parse(fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.equal(last.v, 3);
  assert.equal(parseJournal(fs.readFileSync(path.join(root, "runs", runId, "journal.jsonl")), runId).integrity.status, "ok");
});

test("older readers: 1.5.19 (no resolution kind known: a newer journal) and 1.5.7 see a newer version, replay nothing", () => {
  const runId = randomUUID();
  const buf = lines(runId, [["run.created", { goal: T, kind: "resolution" }], ["workspace.created", WS], ["plan.recorded", APP_PLAN]]);
  // the reader of a build that does not know the kind: maxVersion 1 here stands for «v3 is above me» in the same code
  assert.equal(newerVersion(buf, 1), 3);
  const old = parseJournal(buf, runId, { maxVersion: 1, readerVersion: 1 });
  assert.equal(old.integrity.status, "newer_version");
  assert.equal(old.state, null);
});

test("the application's plan: only in a resolution run, only first after the workspace, its exact form", () => {
  const runId = randomUUID();
  const created = ["run.created", { goal: T, kind: "resolution" }];
  // before the workspace
  assert.equal(parseJournal(lines(runId, [created, ["plan.recorded", APP_PLAN]]), runId).integrity.detail.code, "replay_conflict");
  // twice
  assert.equal(parseJournal(lines(runId, [created, ["workspace.created", WS], ["plan.recorded", APP_PLAN], ["plan.recorded", APP_PLAN]]), runId).integrity.detail.code, "replay_conflict");
  // not its form
  for (const bad of [{ ...APP_PLAN, by: "lead" }, { ...APP_PLAN, version: 2 }, { ...APP_PLAN, turnId: randomUUID() }, { ...APP_PLAN, firstStage: 2 }]) {
    assert.equal(isValidEventData("plan.recorded", bad, RESOLUTION_VERSION), false, JSON.stringify(bad));
  }
  // in a journal v2 the application's plan is no record at all
  assert.equal(isValidEventData("plan.recorded", APP_PLAN, 2), false);
  const v2 = lines(runId, [["run.created", { goal: T }], ["workspace.created", WS], ["plan.recorded", APP_PLAN]], 2, { minReaderVersion: 2 });
  assert.equal(parseJournal(v2, runId).integrity.status, "corrupt");
  // run.created v2 does not take a kind; a v3 run.created without the kind is not a resolution run — a newer journal
  assert.equal(isValidEventData("run.created", { goal: T, kind: "resolution" }, 2), false);
  const other = lines(runId, [["run.created", { goal: T }]]);
  assert.equal(isResolutionJournal(other), false);
  assert.equal(parseJournal(other, runId).integrity.status, "newer_version");
  // a resolution head without minReaderVersion 3 is not one either
  assert.equal(isResolutionJournal(lines(runId, [created], 3, { minReaderVersion: 2 })), false);
});

test("a line of another v in a resolution journal breaks it", () => {
  const runId = randomUUID();
  const head = buildRecord(null, runId, "2026-10-19T10:00:00.000Z", "run.created", { goal: T, kind: "resolution" }, 3, { minReaderVersion: 3 });
  const second = buildRecord(head.record, runId, "2026-10-19T10:00:01.000Z", "workspace.created", WS, 2);
  const p = parseJournal(Buffer.concat([head.line, second.line]), runId);
  assert.equal(p.integrity.status, "corrupt");
  assert.equal(p.integrity.detail.code, "invalid_event");
});
