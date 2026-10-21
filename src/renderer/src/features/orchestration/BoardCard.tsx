// B2: the task board on the canvas (stage-b-board.md §6). One card per workspace, moved and resized as an agent card
// is. Its columns and every line of a task card come from the shared status (boardStatuses) and the same display rules
// as the agent cards (runStatus); the board only sends what the person asked for — main checks every rule.
import { useState } from "react";
import type { LocaleId, SessionBounds } from "../../../../shared/contracts";
import type { OrchestrationAgentLink } from "../../../../shared/orchestration";
import { AUTOPILOT_BUDGET, type AutopilotLimit, conflictsOf, externalInForce, isCopy, startBase, taskText, mergeMark, parallelOf, type AutopilotBudget, type AutopilotState, type BoardHead, type BoardMerge, type BoardTask, type ImportReport, type InboxRow, type InboxTask, type RunTaskFacts, type TaskColumn, type TaskStatus } from "../../../../shared/taskBoard";
import { t, type TranslationKey } from "../../lib/i18n";
import { Dialog } from "./OrchestrationDialogs";
import { ACTIVE_STATUSES, providerName, resetTime } from "./runModel";
import { ASKS_HINT_OVER, askCount, permissionLine, splitActions, stopText, subtaskInfo, taskLine, tr, unsplit } from "./boardModel";
import { conditionsLine, costLine, findingsLine } from "./runStatus";
import type { AgentCanvasUi } from "./useAgentCanvasUi";
import type { Board } from "./useBoard";
import { RESIZE_DIRECTIONS, useCardFrame } from "./useCardFrame";
import type { Orchestration } from "./useOrchestration";

export const BOARD_SIZE = { width: 1040, height: 560 };
const LIMITS = { min: { width: 560, height: 320 }, max: { width: 4000, height: 3000 } };
const COLUMNS: TaskColumn[] = ["queue", "work", "review", "done"];

export interface BoardCardProps {
  board: Board;
  orch: Orchestration; // this workspace's agents and links (the scene's)
  ui: AgentCanvasUi;
  locale: LocaleId;
  workspaceId: string;
  bounds: SessionBounds;
  zoom: number;
  stackIndex: number;
  selected: boolean;
  snapEnabled: boolean;
  snapTargets: readonly SessionBounds[];
  defaultProject: string | null;
  onBoundsChange(bounds: SessionBounds): void;
  onHide(): void;
}

export function BoardCard(props: BoardCardProps): React.JSX.Element {
  const { board, orch, ui, locale, workspaceId } = props;
  const frame = useCardFrame({ bounds: props.bounds, zoom: props.zoom, snapEnabled: props.snapEnabled, snapTargets: props.snapTargets, limits: LIMITS,
    onMoved: props.onBoundsChange, onResized: props.onBoundsChange });
  const { position, size } = frame.bounds;
  const [showArchive, setShowArchive] = useState(false);
  const [form, setForm] = useState<{ task: BoardTask | null } | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [marking, setMarking] = useState<string | null>(null); // F2: «Выполнено» asked for this external task (its note)
  const [note, setNote] = useState("");
  const [anyway, setAnyway] = useState<string | null>(null); // «Start anyway» asked for this task
  const [message, setMessage] = useState<{ taskId: string | null; text: string } | null>(null);
  // F1 (T-2): «Import tasks» under way, and the report window (the button's result, or an inbox/ file's after «Import»)
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const newInputs = window.canvasTTY.orchestration.newInputs;
  const view = board.view;
  const readOnly = !!view?.readOnly;
  const tasks = (view?.board.tasks ?? []).filter((x) => x.workspaceId === workspaceId);
  const keyOf = (id: string) => tasks.find((x) => x.id === id)?.key ?? "?";
  const keysOf = (ids: string[]) => ids.map(keyOf).join(", ");
  const shown = tasks.filter((x) => (showArchive ? x.archivedAt : !x.archivedAt));
  const leadOf = (l: OrchestrationAgentLink) => orch.canvas.agents.find((a) => a.agentId === l.fromAgentId);
  // C1: a link whose runs go on in separate copies is free for another task (main checks the slot and the mode)
  const busy = (l: OrchestrationAgentLink) => l.runIds.slice(-4).some((id) => {
    const v = orch.runs[id]?.view;
    return !!v && ((ACTIVE_STATUSES.includes(v.status) && !isCopy(v.workMode)) || !!v.newer);
  });
  const say = (taskId: string | null, text: string) => {
    setMessage({ taskId, text });
    window.setTimeout(() => setMessage((m) => (m?.text === text ? null : m)), 8000);
  };
  const failure = (r: { ok: boolean; code?: string; message?: string }) => (r.ok ? null : tr(locale, `orchError_${r.code}`) || r.message || String(r.code));
  // «Start»: the goal dialog of a free link of the task's folder, with the task's text, requirements and goal.task
  const start = (task: BoardTask, startAnyway = false) => {
    const links = orch.canvas.links.filter((l) => leadOf(l)?.project === task.project);
    const link = links.find((l) => !busy(l));
    if (!link) { say(task.id, tr(locale, "boardNoLink", { project: task.project })); return; }
    // C2: a place with the board's merged head starts from it (its dependencies are there, decision 9); else B's base
    const base = view ? startBase(task, view.board, board.statuses, view.facts, view.heads ?? []) : null;
    ui.openGoal(link.linkId, { id: task.id, key: task.key, title: task.title, text: taskText(task, view?.board.tasks ?? [], locale === "ru" ? "ru" : "en"), criteria: task.criteria, ...(startAnyway ? { anyway: true } : {}), ...(base ? { base } : {}) });
  };
  const projects = [...new Set([...orch.canvas.agents.map((a) => a.project), ...(props.defaultProject ? [props.defaultProject] : [])])];
  const language = locale === "ru" ? "ru" : "en";
  // C1: the board's merged head of each project of this workspace
  const heads = (view?.heads ?? []).filter((h) => h.workspaceId === workspaceId);
  const headOf = (task: BoardTask) => heads.find((h) => h.project === task.project);
  const [merging, setMerging] = useState<string | null>(null); // «Объединить» of a task not started from the head, asked
  const [over, setOver] = useState<string | null>(null); // C2: «Запустить сейчас сверх лимита» asked for this task
  const queueAct = async (action: "run" | "cancel", task: BoardTask) => { setOver(null); const f = failure(await board.queue(action, task.id)); if (f) say(task.id, f); };
  const mergeTask = async (task: BoardTask) => { setMerging(null); const f = failure(await board.merge(task.id, language)); if (f) say(task.id, f); };
  // E4 (stage-e-decomposition.md §10): «Split» / «Split again» start the decomposition run; «Do it whole» takes the mark off
  // F2 (T-3): «Выполнено» (with the note) and «Снять отметку» of an external task
  const markAct = async (task: BoardTask, done: boolean) => {
    setMarking(null);
    const f = failure(await board.external(task.id, done, done && note.trim() ? note : undefined));
    if (f) say(task.id, f);
  };
  const splitAct = async (task: BoardTask, action: "decompose" | "whole") => {
    const f = failure(await (action === "decompose" ? board.decompose(task.id, language) : board.update(task.id, { decompose: false })));
    if (f) say(task.id, f);
  };
  // a subtask's key links to its card (a parent's to the parent's)
  const goTo = (key: string) => {
    const el = document.querySelector<HTMLElement>(`[data-board="${workspaceId}"] [data-board-task="${key}"]`);
    el?.scrollIntoView({ block: "nearest" });
    el?.querySelector<HTMLElement>(".board-task__title")?.focus();
  };

  return (
    <article className={`board-card ${props.selected ? "board-card--selected" : ""}`} data-interactive="true" data-board={workspaceId}
      data-canvas-layer-id={`board:${workspaceId}`} aria-label={t(locale, "boardTitle")}
      style={{ zIndex: props.stackIndex, width: size.width, height: size.height, transform: `translate(${position.x}px, ${position.y}px)` }}>
      <header className="board-card__header" {...frame.header}>
        <strong>{t(locale, "boardTitle")}</strong>
        {readOnly && <span className="board-card__readonly" role="status">{t(locale, "boardReadOnly")}</span>}
        <span className="board-card__header-actions">
          <button type="button" data-board-new disabled={readOnly} onClick={() => setForm({ task: null })}>{t(locale, "boardNewTask")}</button>
          <button type="button" data-board-import disabled={readOnly || !newInputs || importing} aria-busy={importing}
            title={newInputs ? undefined : t(locale, "boardImportCode_unsupported_platform")} onClick={async () => {
              setImporting(true);
              const r = await board.importFile();
              setImporting(false);
              if (!r.ok) say(null, importText(locale, r.code, r.message));
              else if (r.value) setReport(r.value);
            }}>{importing ? `${t(locale, "boardImport")}…` : t(locale, "boardImport")}</button>
          <button type="button" data-board-archive-toggle aria-pressed={showArchive} onClick={() => setShowArchive((v) => !v)}>
            {t(locale, showArchive ? "boardHideArchive" : "boardShowArchive")}</button>
          <button type="button" className="board-card__hide" data-board-hide title={t(locale, "boardHide")} aria-label={t(locale, "boardHide")} onClick={props.onHide}>×</button>
        </span>
      </header>
      {view && !readOnly && orch.canvas.links.map((l) => (
        <AutopilotRow key={l.linkId} locale={locale} state={view.autopilot?.[l.linkId] ?? null} project={leadOf(l)?.project ?? ""} many={orch.canvas.links.length > 1}
          onSet={async (on) => { const r = await board.autopilot(l.linkId, on, locale === "ru" ? "ru" : "en"); const f = failure(r); if (f) say(null, f); }}
          onBudget={async (b) => { const r = await board.budget(l.linkId, b); const f = failure(r); if (f) say(null, f); }} />
      ))}
      {view && !readOnly && heads.map((h) => (
        <HeadRow key={h.ref} locale={locale} head={h} tasks={tasks} statuses={board.statuses} facts={view.facts} board={board} workspaceId={workspaceId} say={(text) => say(null, text)} failure={failure} openRun={(id) => ui.openRunById(id)} />
      ))}
      {!!view?.inbox?.some((r) => (r.workspaceId ?? workspaceId) === workspaceId) && <div className="board-card__inbox-list" data-wheel-owner="local">
      {(view?.inbox ?? []).filter((r) => (r.workspaceId ?? workspaceId) === workspaceId).map((r) => (
        <InboxLine key={r.file} locale={locale} row={r} readOnly={readOnly}
          onImport={async () => {
            const x = await board.inboxImport(r.file, r.sha256);
            if (!x.ok) say(null, importText(locale, x.code, x.message));
            else setReport(x.value); // imported — the result; checked — the board moved on: the new report, a second «Import»
          }}
          onReject={async () => { const x = await board.inboxReject(r.file); if (!x.ok) say(null, importText(locale, x.code, x.message)); }} />
      ))}</div>}
      {board.failed && !view && <p className="board-card__message" role="alert">{t(locale, "boardLoadFailed")} ({board.failed})</p>}
      {message && !message.taskId && <p className="board-card__message" role="alert">{message.text}</p>}
      {view && tasks.length === 0 && <p className="board-card__empty" data-board-empty>{t(locale, "boardEmpty")}</p>}
      <div className="board-card__columns" data-wheel-owner="local">
        {COLUMNS.map((column) => {
          const items = shown.filter((x) => (showArchive ? column === "queue" : board.statuses.get(x.id)?.column === column))
            .sort((a, b) => a.order - b.order);
          return (
            <section key={column} className={`board-card__column board-card__column--${column}`} data-board-column={column} aria-label={t(locale, `boardCol_${column}`)}>
              <h3>{showArchive && column === "queue" ? t(locale, "boardArchived") : t(locale, `boardCol_${column}`)} <span data-board-count>{items.length}</span></h3>
              <ul className="board-card__list">
                {items.length === 0 && <li className="board-card__column-empty">{t(locale, "boardColumnEmpty")}</li>}
                {items.map((task) => {
                  const st = board.statuses.get(task.id)!;
                  const runId = st.current;
                  const run = runId ? orch.runs[runId] : undefined;
                  // E4: a parent has no run of its own — its line, answer and «Open the split» follow its decomposition run
                  const lineId = runId ?? st.split?.runId ?? null;
                  const entries = runId ? orch.activity[runId]?.entries ?? [] : [];
                  const fact = lineId ? view?.facts.find((f) => f.runId === lineId) : undefined;
                  const base = taskLine(locale, st, run ? { view: run.view, entries, open: run.open } : null, fact?.limit ?? null, fact?.providerLimit ?? null);
                  // what is asked, in the request's own words and the CLI's reason (answered in the run panel: one home for answers)
                  // F2: an external task in force — the person's mark is what it waits for, never a run
                  const external = externalInForce(task, st);
                  const depsOpen = task.dependsOn.some((d) => tasks.some((x) => x.id === d) && !board.statuses.get(d)?.done);
                  const line = st.reason === "waits_permission" ? permissionLine(locale, base, (lineId ? orch.runs[lineId] : undefined)?.view.permission)
                    : external && !st.done && !st.reason ? t(locale, "boardExternalWaits") : base;
                  // without checks, the conditions are met by the agents' word only
                  const met = run ? conditionsLine(locale, run.view) : null;
                  // shown once the run's feed is here: «0» before it loads would be a guess
                  const asks = runId && orch.activity[runId]?.status === "ready" ? askCount(entries) : 0;
                  const facts = [met && (st.completion === "no_checks" ? `${met} (${t(locale, "boardByAgents")})` : met), run && findingsLine(locale, run.view),
                    st.attempts > 0 && tr(locale, "boardAttempt", { n: st.attempts }), asks > 0 && tr(locale, "boardAsks", { n: asks })].filter(Boolean).join(" · ");
                  // the tasks that go on once this one is accepted
                  const next = tasks.filter((x) => !x.archivedAt && x.dependsOn.includes(task.id)).map((x) => x.key);
                  const cost = run ? costLine(locale, "executor", run.view, entries) : null;
                  // «after T-2» while T-2 is not done and the line does not say so already
                  const open = task.dependsOn.filter((d) => !board.statuses.get(d)?.done);
                  const after = open.length && st.reason !== "waits_task" && st.reason !== "waits_external" ? tr(locale, "boardAfter", { keys: keysOf(open) }) : null;
                  const archived = !!task.archivedAt;
                  // C1 (§4.4): «Done · in the board's result / merging / not merged: why», from the merge journals
                  const head = headOf(task);
                  const mark = st.done ? mergeMark(task.id, head, st.current) : null;
                  // decision 15: «already in the result» when nothing was merged; «without checks» only when there were none
                  const markText = mark && (mark.kind === "in_board" ? t(locale, mark.already ? "boardMark_in_board_already" : mark.checks ? "boardMark_in_board" : "boardMark_in_board_nochecks")
                    : mark.kind === "merging" ? t(locale, mark.agent ? "boardMark_merging_agent" : "boardMark_merging") : tr(locale, "boardMark_not_merged", { reason: tr(locale, `boardMergeReason_${mark.reason}`) || mark.reason }));
                  const canMerge = !!st.done && isCopy(fact?.workMode) && (!mark || (mark.kind === "not_merged" && !mark.waits));
                  // C2: a start waiting for a place (decision 12), and the files it shares with others (§4.7)
                  const queued = view?.queued?.find((q) => q.taskId === task.id);
                  const overlaps = board.overlaps.get(task.id) ?? [];
                  // E4 (§10): a parent's row of §2.1, its subtasks; a subtask's parent
                  const acts = splitActions(task, st);
                  const subs = view ? subtaskInfo(task, tasks, board.statuses, view.facts, view.heads ?? []) : null;
                  const parent = task.parentId ? tasks.find((x) => x.id === task.parentId) : undefined;
                  return (
                    <li key={task.id} className={`board-task board-task--${st.column}${st.done ? ` board-task--done-${st.done}` : ""}`}
                      data-board-task={task.key} data-board-task-column={st.column} data-board-done={st.done ?? undefined} data-board-reason={st.reason ?? undefined}>
                      <button type="button" className="board-task__title" aria-label={`${task.key} ${task.title}. ${line}`}
                        onClick={() => (runId ? ui.openRunById(runId) : setForm({ task }))} title={task.title}>
                        <span className="board-task__key">{task.key}</span> {task.title}
                      </button>
                      <div className="board-task__line" data-board-line title={line}>
                        {st.done && <span className={`board-task__badge board-task__badge--${st.done}`} aria-hidden="true">{st.done === "confirmed" ? "✓" : "✋"}</span>}
                        <span data-board-line-text>{line}</span>
                      </div>
                      {task.external && <div className="board-task__line board-task__hint" data-board-external={external ? (st.done ? "done" : "waits") : "runs"}
                        title={task.externalDone?.note ?? undefined}>{external ? t(locale, "boardExternal") : t(locale, "boardReason_external_has_runs")}{external && task.externalDone?.note ? ` · ${task.externalDone.note}` : ""}</div>}
                      {facts && <div className="board-task__line board-task__facts" data-board-facts title={facts}>{facts}</div>}
                      {asks > ASKS_HINT_OVER && <div className="board-task__line board-task__hint" data-board-asks-hint>{t(locale, "boardAsksHint")}</div>}
                      {st.depsNote && <div className="board-task__line board-task__hint" data-board-deps-note={st.depsNote}>{t(locale, `boardDepsNote_${st.depsNote}`)}</div>}
                      {parent && <div className="board-task__line" data-board-part-of={parent.key}>
                        <button type="button" className="board-task__link" onClick={() => goTo(parent.key)}>{tr(locale, "boardPartOf", { key: parent.key })}</button>
                        {parent.archivedAt && <span data-board-parent-archived>{` · ${t(locale, "boardParentArchived")}`}</span>}</div>}
                      {parent && task.covers?.length ? <div className="board-task__line board-task__hint" data-board-covers>{tr(locale, "boardCovers", { ids: task.covers.join(", "), key: parent.key })}</div> : null}
                      {subs && <div className="board-task__line" data-board-subtasks={`${subs.done}/${subs.live.length}`}>{tr(locale, "boardSubtasks", { done: subs.done, n: subs.live.length })}
                        {subs.live.map((x) => <button key={x.id} type="button" className="board-task__link" data-board-subtask-link={x.key} onClick={() => goTo(x.key)}>{` ${x.key}`}</button>)}</div>}
                      {subs?.archived.map((x) => <div key={x.id} className="board-task__line board-task__hint" data-board-subtask-archived={x.key}>{tr(locale, "boardSubtaskArchived", { key: x.key })}</div>)}
                      {subs?.criteriaChanged && <div className="board-task__line board-task__hint" data-board-criteria-changed>{t(locale, "boardCriteriaChanged")}</div>}
                      {after && <div className="board-task__line" data-board-after title={after}>{after}</div>}
                      {markText && <div className="board-task__line" data-board-merge-mark={mark!.kind === "in_board" && mark!.already ? "already" : mark!.kind} title={markText}>{markText}</div>}
                      {queued && !queued.failed && <div className="board-task__line" data-board-queued title={tr(locale, "boardQueued", { busy: queued.busy, limit: queued.limit })}>
                        {tr(locale, "boardQueued", { busy: queued.busy, limit: queued.limit })}</div>}
                      {queued?.failed && <div className="board-task__line board-task__hint" data-board-queued-failed={queued.failed}>
                        {tr(locale, "boardQueuedFailed", { reason: tr(locale, `orchError_${queued.failed}`) || queued.failed })}</div>}
                      {overlaps.map((o) => {
                        const text = tr(locale, o.kind === "now" ? "boardOverlapNow" : "boardOverlapMaybe", { key: o.key, files: o.files.slice(0, 5).join(", ") + (o.files.length > 5 ? " …" : "") });
                        return <div key={`${o.kind}:${o.key}`} className="board-task__line board-task__hint" data-board-overlap={o.kind} data-board-overlap-with={o.key} title={o.files.join(", ")}>{text}</div>;
                      })}
                      {over === task.id && queued && (
                        <div className="board-task__confirm" role="alertdialog" aria-label={t(locale, "boardQueuedOver")} data-board-over-confirm>
                          <p>{tr(locale, "boardQueuedOverWhy", { busy: queued.busy, limit: queued.limit, key: task.key })}</p>
                          <button type="button" className="orch-primary" data-board-over-yes onClick={() => void queueAct("run", task)}>{t(locale, "boardQueuedOver")}</button>
                          <button type="button" onClick={() => setOver(null)}>{t(locale, "orchCancel")}</button>
                        </div>
                      )}
                      {merging === task.id && (
                        <div className="board-task__confirm" role="alertdialog" aria-label={t(locale, "boardMerge")} data-board-merge-confirm>
                          <p>{tr(locale, "boardMergeNotFromHead", { key: task.key })}</p>
                          <button type="button" className="orch-primary" data-board-merge-yes onClick={() => void mergeTask(task)}>{t(locale, "boardMerge")}</button>
                          <button type="button" onClick={() => setMerging(null)}>{t(locale, "orchCancel")}</button>
                        </div>
                      )}
                      {run && <div className="board-task__line" data-board-executor title={cost ?? undefined}>{tr(locale, "boardExecutor", { who: "Claude" })}{cost ? ` · ${cost}` : ""}</div>}
                      {message?.taskId === task.id && <div className="board-task__message" role="alert">{message.text}</div>}
                      {accepting === task.id && (
                        <div className="board-task__confirm" role="alertdialog" aria-label={t(locale, "boardAccept")} data-board-accept-confirm>
                          <p>{t(locale, "boardAcceptWhy")}{next.length ? ` ${tr(locale, "boardAcceptNext", { keys: next.join(", ") })}` : ""}</p>
                          {st.depsWait && <p className="orch-hint orch-hint--warn" data-board-accept-deps>{tr(locale, "boardAcceptDepsWarn", { keys: st.depsWait.waitsFor.join(", ") })}</p>}
                          <button type="button" className="orch-primary" data-board-accept-yes onClick={async () => {
                            setAccepting(null);
                            const r = await board.accept(task.id);
                            const f = failure(r);
                            if (f) say(task.id, f);
                          }}>{t(locale, "boardAcceptConfirm")}</button>
                          <button type="button" onClick={() => setAccepting(null)}>{t(locale, "orchCancel")}</button>
                        </div>
                      )}
                      {marking === task.id && (
                        <div className="board-task__confirm" role="alertdialog" aria-label={t(locale, "boardExternalDone")} data-board-external-confirm>
                          <label className="orch-field">{t(locale, "boardExternalNote")}
                            <input type="text" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} data-board-external-note /></label>
                          <button type="button" className="orch-primary" data-board-external-yes onClick={() => void markAct(task, true)}>{t(locale, "boardExternalDone")}</button>
                          <button type="button" onClick={() => setMarking(null)}>{t(locale, "orchCancel")}</button>
                        </div>
                      )}
                      {anyway === task.id && (
                        <div className="board-task__confirm" role="alertdialog" aria-label={t(locale, "boardStartAnyway")} data-board-anyway-confirm>
                          <p>{tr(locale, `boardStartAnywayWhy_${st.depsWait?.reason ?? "waits_task"}`, { keys: st.depsWait?.waitsFor.join(", ") ?? "" })}</p>
                          <button type="button" className="orch-primary" data-board-anyway-yes onClick={() => { setAnyway(null); start(task, true); }}>{t(locale, "boardStartAnyway")}</button>
                          <button type="button" onClick={() => setAnyway(null)}>{t(locale, "orchCancel")}</button>
                        </div>
                      )}
                      {!readOnly && accepting !== task.id && anyway !== task.id && marking !== task.id && (
                        <div className="board-task__actions">
                          {archived ? (
                            <button type="button" data-board-unarchive onClick={() => void board.archive(task.id, false)}>{t(locale, "boardUnarchive")}</button>
                          ) : (
                            <>
                              {/* §4.2: by its dependencies, whatever its own column — ready: «Start»; not: «Start anyway», confirmed first */}
                              {queued && !queued.failed && over !== task.id && <>
                                <button type="button" data-board-over onClick={() => setOver(task.id)}>{t(locale, "boardQueuedOver")}</button>
                                <button type="button" data-board-queue-cancel onClick={() => void queueAct("cancel", task)}>{t(locale, "boardQueuedCancel")}</button>
                              </>}
                              {/* F2 (§10): the external task's mark — the only «Done» it has; «Снять отметку» while no dependent began (main checks) */}
                              {external && !st.done && <button type="button" className="orch-primary" data-board-external-done disabled={depsOpen}
                                title={depsOpen ? t(locale, "orchError_deps_not_done") : undefined} onClick={() => { setNote(""); setMarking(task.id); }}>{t(locale, "boardExternalDone")}</button>}
                              {external && st.done && <button type="button" data-board-external-undo onClick={() => void markAct(task, false)}>{t(locale, "boardExternalUndo")}</button>}
                              {!external && (st.column === "queue" || st.reason === "no_checks") && st.reason !== "run_newer" && !(queued && !queued.failed) && !unsplit(task, st) && (st.depsWait
                                ? <button type="button" data-board-start-anyway onClick={() => setAnyway(task.id)}>{t(locale, "boardStartAnyway")}</button>
                                : <button type="button" data-board-start onClick={() => start(task)}>{t(locale, st.attempts ? "boardStartAgain" : "boardStart")}</button>)}
                              {/* E4: the actions of a parent's row (§2.1); «Stop» is the split run's panel's */}
                              {acts.includes("run") && <button type="button" className="orch-primary" data-board-decompose onClick={() => void splitAct(task, "decompose")}>{t(locale, "boardDecomposeRun")}</button>}
                              {acts.includes("again") && <button type="button" className="orch-primary" data-board-decompose-again onClick={() => void splitAct(task, "decompose")}>{t(locale, "boardDecomposeAgain")}</button>}
                              {acts.includes("whole") && <button type="button" data-board-decompose-whole onClick={() => void splitAct(task, "whole")}>{t(locale, "boardDecomposeWhole")}</button>}
                              {acts.includes("answer") && st.split && <button type="button" className="orch-primary" data-board-split-answer onClick={() => ui.openRunById(st.split!.runId)}>{t(locale, "boardAnswer")}</button>}
                              {acts.includes("open") && st.split && <button type="button" data-board-split-open onClick={() => ui.openRunById(st.split!.runId)}>{t(locale, "boardDecomposeOpen")}</button>}
                              {runId && st.reason === "waits_permission"
                                ? <button type="button" className="orch-primary" data-board-open data-board-answer onClick={() => ui.openRunById(runId)}>{t(locale, "boardAnswer")}</button>
                                : runId && <button type="button" data-board-open onClick={() => ui.openRunById(runId)}>{t(locale, "orchOpenRun")}</button>}
                              {runId && <>
                                <button type="button" data-board-open-plan onClick={() => ui.openRunById(runId, "plan")}>{t(locale, "orchTab_plan")}</button>
                                <button type="button" data-board-open-result onClick={() => ui.openRunById(runId, "result")}>{t(locale, "orchTab_result")}</button>
                              </>}
                              {st.reason === "no_checks" && <button type="button" className="orch-primary" data-board-accept onClick={() => setAccepting(task.id)}>{t(locale, "boardAccept")}</button>}
                              {canMerge && merging !== task.id && <button type="button" data-board-merge
                                onClick={() => (head && fact?.board === head.ref ? void mergeTask(task) : setMerging(task.id))}>{t(locale, "boardMerge")}</button>}
                              {mark?.kind === "not_merged" && !mark.waits && mark.reason !== "skipped" && <button type="button" data-board-merge-skip-failed
                                onClick={async () => { const f = failure(await board.skip(mark.runId)); if (f) say(task.id, f); }}>{t(locale, "boardMergeSkip")}</button>}
                              {(st.column === "queue" || st.column === "done") && <button type="button" data-board-edit onClick={() => setForm({ task })}>{t(locale, "boardEdit")}</button>}
                              {(st.column === "queue" || st.column === "done") && <button type="button" data-board-archive onClick={() => void board.archive(task.id, true)}>{t(locale, "boardArchive")}</button>}
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      {RESIZE_DIRECTIONS.map((direction) => (
        <div key={direction} className={`terminal-card__resize-handle terminal-card__resize-handle--${direction}`} aria-hidden="true" data-board-resize={direction}
          {...frame.handle(direction)} />
      ))}
      {report && (
        <Dialog label={t(locale, "boardImport")} onClose={() => setReport(null)} locale={locale}>
          <ImportReportView locale={locale} report={report} tasks={view?.inbox?.find((r) => r.file === report.file)?.tasks ?? []} />
        </Dialog>
      )}
      {form && (
        <TaskForm locale={locale} task={form.task} splitLocked={!!form.task && ((board.statuses.get(form.task.id)?.attempts ?? 0) > 0 || tasks.some((x) => x.parentId === form.task!.id && !x.archivedAt))} tasks={tasks.filter((x) => !x.archivedAt)} projects={projects}
          dependents={form.task ? tasks.filter((x) => x.dependsOn.includes(form.task!.id)) : []}
          onClose={() => setForm(null)}
          onSave={async (input) => {
            const { decompose, ...rest } = input;
            const r = form.task ? await board.update(form.task.id, { title: input.title, text: input.text, criteria: input.criteria, dependsOn: input.dependsOn, ...(decompose !== !!form.task.decompose ? { decompose } : {}) })
              : await board.create({ workspaceId, ...rest, ...(decompose ? { decompose } : {}) });
            const f = failure(r);
            if (!f) setForm(null);
            return f;
          }}
          onDelete={form.task && !(board.statuses.get(form.task.id)?.attempts) ? async (dependents) => {
            const f = failure(await board.remove(form.task!.id, dependents));
            if (!f) setForm(null);
            return f;
          } : undefined} />
      )}
    </article>
  );
}

// «New task» / «Edit task»: the goal's fields without a start (§6). main checks the rest (lengths, cycles, the folder).
function TaskForm({ locale, task, splitLocked, tasks, projects, dependents, onClose, onSave, onDelete }: {
  locale: LocaleId; task: BoardTask | null; splitLocked: boolean; tasks: BoardTask[]; projects: string[]; dependents: BoardTask[]; onClose(): void;
  onSave(input: { project: string; title: string; text: string; criteria: string[]; dependsOn: string[]; decompose: boolean }): Promise<string | null>;
  // dependents: the tasks shown as losing this dependency (§4.2: removed openly, never on the quiet)
  onDelete?: (dependents: string[]) => Promise<string | null>;
}): React.JSX.Element {
  const [deleting, setDeleting] = useState(false);
  const [title, setTitle] = useState(task?.title ?? "");
  const [text, setText] = useState(task?.text ?? "");
  const [criteria, setCriteria] = useState(task?.criteria.join("\n") ?? "");
  const [project, setProject] = useState(task?.project ?? projects[0] ?? "");
  const [depends, setDepends] = useState<string[]>(task?.dependsOn ?? []);
  const [decompose, setDecompose] = useState(!!task?.decompose); // E4 (§10)
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lines = criteria.split("\n").map((c) => c.trim()).filter(Boolean);
  const complete = title.trim() && text.trim() && lines.length > 0 && project.trim();
  const others = tasks.filter((x) => x.id !== task?.id);
  return (
    <Dialog label={t(locale, task ? "boardEditTask" : "boardNewTask")} onClose={onClose} locale={locale}>
      <form className="orch-form" data-board-form onSubmit={async (event) => {
        event.preventDefault();
        if (!complete) return;
        setBusy(true);
        setError(await onSave({ project: project.trim(), title: title.trim(), text: text.trim(), criteria: lines, dependsOn: depends, decompose }));
        setBusy(false);
      }}>
        {task && <div className="orch-field orch-field--static"><span>{t(locale, "boardTask")}</span><strong>{task.key}</strong></div>}
        <label className="orch-field"><span>{t(locale, "boardFieldTitle")}</span>
          <input data-board-field="title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label className="orch-field"><span>{t(locale, "boardFieldText")}</span>
          <textarea data-board-field="text" value={text} maxLength={8000} rows={4} onChange={(e) => setText(e.target.value)} /></label>
        <label className="orch-field"><span>{t(locale, "boardFieldCriteria")}</span>
          <textarea data-board-field="criteria" value={criteria} rows={3} onChange={(e) => setCriteria(e.target.value)} /></label>
        <label className="orch-field"><span>{t(locale, "boardFieldProject")}</span>
          <input data-board-field="project" value={project} list="board-projects" disabled={!!task} onChange={(e) => setProject(e.target.value)} />
          <datalist id="board-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist></label>
        {/* E4 (§10): not for a subtask; not while the task has its own run or live subtasks */}
        {!task?.parentId && <label className="orch-field orch-field--check"><input type="checkbox" data-board-field="decompose" checked={decompose} disabled={splitLocked}
          onChange={(e) => setDecompose(e.target.checked)} /> {t(locale, "boardDecompose")}</label>}
        {(
          <fieldset className="orch-field board-form__depends"><legend>{t(locale, "boardFieldDepends")}</legend>
            {others.length === 0 && <small className="orch-hint">{t(locale, "boardNoOtherTasks")}</small>}
            {others.map((x) => (
              <label key={x.id}><input type="checkbox" data-board-depends={x.key} checked={depends.includes(x.id)}
                onChange={(e) => setDepends((d) => (e.target.checked ? [...d, x.id] : d.filter((y) => y !== x.id)))} /> {x.key} · {x.title}</label>
            ))}
          </fieldset>
        )}
        {error && <p className="orch-error" role="alert">{error}</p>}
        {deleting && <p className="orch-hint orch-hint--warn" role="alert" data-board-delete-dependents>
          {tr(locale, "boardDeleteDependents", { keys: dependents.map((x) => x.key).join(", ") })}</p>}
        {!complete && <p className="orch-hint" data-board-form-incomplete>{t(locale, "boardFormIncomplete")}</p>}
        <div className="orch-actions">
          {onDelete && <button type="button" className="orch-danger" data-board-delete
            onClick={async () => (dependents.length && !deleting ? setDeleting(true) : setError(await onDelete(dependents.map((x) => x.id))))}>
            {t(locale, deleting ? "boardDeleteConfirm" : "boardDelete")}</button>}
          <button type="button" onClick={onClose}>{t(locale, "orchCancel")}</button>
          <button type="submit" className="orch-primary" data-board-save disabled={!complete || busy}>{t(locale, "boardSave")}</button>
        </div>
      </form>
    </Dialog>
  );
}

// B4: «Run the board» on a link (stage-b-board.md §5): on — what it waits for and how much of the budget is used; off —
// why it stopped last. Turning it on says what it does; the budget is the link's, kept in board.json.
function AutopilotRow({ locale, state, project, many, onSet, onBudget }: {
  locale: LocaleId; state: AutopilotState | null; project: string; many: boolean; onSet(on: boolean): Promise<void>; onBudget(b: AutopilotBudget): Promise<void>;
}): React.JSX.Element {
  const budget = state?.budget ?? AUTOPILOT_BUDGET;
  const [asking, setAsking] = useState(false);
  const [runs, setRuns] = useState(String(budget.runs));
  const [minutes, setMinutes] = useState(String(budget.minutes));
  const [parallel, setParallel] = useState(String(parallelOf(budget)));
  const [conflicts, setConflicts] = useState(conflictsOf(budget));
  const name = project.split("/").filter(Boolean).at(-1) ?? project;
  const valid = /^\d+$/.test(runs) && +runs >= 1 && +runs <= 100 && /^\d+$/.test(minutes) && +minutes >= 1 && +minutes <= 1440 && /^[1-4]$/.test(parallel);
  const changed = valid && (+runs !== budget.runs || +minutes !== budget.minutes || +parallel !== parallelOf(budget) || conflicts !== conflictsOf(budget));
  return (
    <div className="board-card__autopilot" data-board-autopilot={state?.on ? "on" : "off"}>
      {many && <span className="board-card__autopilot-link">{tr(locale, "boardApLink", { project: name })}</span>}
      {state?.on ? (
        <>
          <strong data-board-autopilot-on>{t(locale, "boardApOn")}</strong>
          {state.waits && <span data-board-autopilot-waits={state.waits}>{state.waits === "provider_limit" && state.limit ? limitText(locale, state.limit) : tr(locale, `boardApWaits_${state.waits}`, { key: state.waitsKey ?? "" })}</span>}
          {state.resumed && state.waits !== "provider_limit" && <span data-board-autopilot-resumed={state.resumed.key}>{tr(locale, "boardApResumed", { key: state.resumed.key, time: resetTime(locale, Date.parse(state.resumed.at)) })}</span>}
          {state.splitting && <span data-board-autopilot-splitting={state.splitting}>{tr(locale, "boardApDecomposing", { key: state.splitting })}</span>}
          <span data-board-autopilot-parallel>{tr(locale, "boardApOnParallel", { n: parallelOf(budget) })}</span>
          <span data-board-autopilot-conflicts={conflictsOf(budget)}>{`${t(locale, "boardApConflicts")}: ${t(locale, `boardApConflicts_${conflictsOf(budget)}`)}`}</span>
          <span data-board-autopilot-used>{tr(locale, "boardApUsed", { runs: state.used.runs, maxRuns: budget.runs, minutes: state.used.minutes, maxMinutes: budget.minutes })}</span>
          <button type="button" data-board-autopilot-off onClick={() => void onSet(false)}>{t(locale, "boardApOff")}</button>
        </>
      ) : asking ? (
        <span className="board-card__autopilot-ask" data-board-autopilot-confirm>
          <span>{t(locale, "boardApToggleWhy")}</span>
          <label>{t(locale, "boardApBudget")}: <input type="number" min={1} max={100} value={runs} onChange={(e) => setRuns(e.target.value)} data-board-budget-runs /> {t(locale, "boardApBudgetRuns")}</label>
          <label><input type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} data-board-budget-minutes /> {t(locale, "boardApBudgetMinutes")}</label>
          <label title={t(locale, "boardApParallelHint")}><input type="number" min={1} max={4} value={parallel} onChange={(e) => setParallel(e.target.value)} data-board-budget-parallel /> {t(locale, "boardApParallelHint")}</label>
          {/* C3 (stage-c3-conflicts.md §8): who resolves a merge conflict */}
          <label title={t(locale, "boardApConflictsHint")}>{t(locale, "boardApConflicts")}:{" "}
            <select value={conflicts} onChange={(e) => setConflicts(e.target.value === "person" ? "person" : "agent")} data-board-budget-conflicts>
              <option value="agent">{t(locale, "boardApConflicts_agent")}</option>
              <option value="person">{t(locale, "boardApConflicts_person")}</option>
            </select></label>
          <button type="button" data-board-autopilot-yes disabled={!valid} onClick={async () => { if (changed) await onBudget({ runs: +runs, minutes: +minutes, parallel: +parallel, conflicts }); setAsking(false); await onSet(true); }}>{t(locale, "boardApToggle")}</button>
          <button type="button" onClick={() => setAsking(false)}>{t(locale, "cancel")}</button>
        </span>
      ) : (
        <>
          <button type="button" data-board-autopilot-start onClick={() => { setRuns(String(budget.runs)); setMinutes(String(budget.minutes)); setParallel(String(parallelOf(budget))); setConflicts(conflictsOf(budget)); setAsking(true); }}>{t(locale, "boardApToggle")}</button>
          {state?.stop && <span className="board-card__autopilot-stop" role="status" data-board-autopilot-stop={state.stop.code}>{tr(locale, "boardApLast", { reason: stopText(locale, state.stop) })}</span>}
        </>
      )}
    </div>
  );
}

// C4 (stage-c4-limits.md §5): what the autopilot waits for at a provider's limit
function limitText(locale: LocaleId, l: AutopilotLimit): string {
  const others = l.others ? tr(locale, "boardApLimitOthers", { n: l.others }) : "";
  const vars = { provider: providerName(l.provider), key: l.key, others };
  if (l.repeated) return tr(locale, "boardApWaits_provider_limit_repeated", vars);
  return l.resetsAt === null ? tr(locale, "boardApWaits_provider_limit_unknown", vars) : tr(locale, "boardApWaits_provider_limit", { ...vars, time: resetTime(locale, l.resetsAt) });
}
// C4 (§3): the resolution run under way waits — at a provider's limit or for the person
function agentWaitsText(locale: LocaleId, key: string, w: NonNullable<NonNullable<BoardMerge["agent"]>["waits"]>): string {
  if (w.kind === "person") return tr(locale, "boardHeadAgentPerson", { key });
  return w.resetsAt === null ? tr(locale, "boardHeadAgentLimitUnknown", { key, provider: providerName(w.provider) })
    : tr(locale, "boardHeadAgentLimit", { key, provider: providerName(w.provider), time: resetTime(locale, w.resetsAt) });
}
// C3/C4: the detail of «the agent did not resolve it»; paused:<reason> names the pause as a run's reason reads
function agentWhyDetail(locale: LocaleId, detail: string | null): string {
  if (!detail?.startsWith("paused:")) return detail ?? "";
  const reason = detail.slice(7);
  return t(locale, `orchReason_${reason}` as TranslationKey) || reason;
}

// C3: what a paused merge may be handed to an agent from (the application still refuses a lock file, a task not from the head)
const TO_AGENT = new Set(["merge_conflict", "merge_checks_failed", "merge_agent_failed", "merge_waits_slot", "merge_budget"]);

// C1 (stage-c-parallel.md §4.1, §4.3, §6.1): the board's merged head of a project — what is in it and whether its checks
// passed; the tasks «Done» from it and not in it; a merge that waits for the person, with its copy and its choices; and
// the person's own actions on it. Nothing here is automatic.
function HeadRow({ locale, head, tasks, statuses, facts, board, workspaceId, say, failure, openRun }: {
  locale: LocaleId; head: BoardHead; tasks: BoardTask[]; statuses: ReadonlyMap<string, TaskStatus>; facts: readonly RunTaskFacts[]; board: Board;
  workspaceId: string; say(text: string): void; failure(r: { ok: boolean; code?: string; message?: string }): string | null; openRun(runId: string): void;
}): React.JSX.Element {
  const [asking, setAsking] = useState<null | "branch" | "apply" | "new" | "update">(null);
  const [answer, setAnswer] = useState<{ runId: string; kind: "unresolved" | "confirm"; files: string[] } | null>(null);
  const language = locale === "ru" ? "ru" : "en";
  const done = head.merges.filter((m) => m.status === "completed");
  const keys = [...new Set([...done].reverse().filter((m) => m.source !== "head").map((m) => m.task.key))];
  // C2: an update from HEAD is named as such, not as a task
  const nameOf = (m: BoardMerge) => (m.source === "head" ? t(locale, "boardHeadFromHead") : m.task.key);
  // C2 (decision 13): the person's commits the head does not have; its update only by the person
  const behind = head.behind ?? 0;
  const many = locale === "ru" ? (behind % 10 === 1 && behind % 100 !== 11 ? "one" : [2, 3, 4].includes(behind % 10) && ![12, 13, 14].includes(behind % 100) ? "few" : "many") : behind === 1 ? "one" : "many";
  // decision 15: a merge that found nothing new checked nothing — it says nothing of the checks
  const merged = done.filter((m) => m.reason !== "already");
  const checks = merged.length ? (merged.some((m) => m.completion === "no_checks") ? t(locale, "boardHeadNoChecks") : t(locale, "boardHeadChecked")) : null;
  const notMerged = tasks.filter((x) => {
    const st = statuses.get(x.id);
    const f = facts.find((y) => y.runId === st?.current);
    return x.project === head.project && st?.done && isCopy(f?.workMode) && f!.board === head.ref && !done.some((m) => m.task.id === x.id);
  });
  const going = head.merges.find((m) => m.status === "preparing" || m.status === "running");
  const waits = head.merges.find((m) => m.status === "paused");
  const act = async (action: "branch" | "apply" | "new" | "update") => {
    setAsking(null);
    const r = await board.head(action, workspaceId, head.project, language);
    const f = failure(r);
    if (f || !r.ok) return say(f ?? "");
    const v = r.value as { name?: string; applied?: boolean; files?: string[]; n?: number };
    say(action === "branch" ? tr(locale, "boardHeadBranchDone", { name: v.name ?? "" }) : action === "new" ? tr(locale, "boardHeadNewDone", { n: v.n ?? 0 })
      : action === "update" ? t(locale, "boardHeadUpdateStarted")
      : v.applied ? t(locale, "boardHeadApplied") : tr(locale, "boardHeadApplyConflict", { files: (v.files ?? []).join(", ") }));
  };
  const check = async (runId: string, confirm: boolean) => {
    const r = await board.resolve(runId, confirm);
    const f = failure(r);
    if (f || !r.ok) { setAnswer(null); return say(f ?? ""); }
    setAnswer(r.value.result === "checking" ? null : { runId, kind: r.value.result, files: r.value.files });
  };
  return (
    <div className="board-card__head" data-board-head={head.ref}>
      <div className="board-card__head-line">
        <strong data-board-head-tasks>{keys.length ? tr(locale, "boardHeadTasks", { keys: keys.join(", ") }) : t(locale, "boardHeadEmpty")}</strong>
        {checks && <span data-board-head-checks={merged.some((m) => m.completion === "no_checks") ? "none" : "passed"}>{` · ${checks}`}</span>}
        {going?.agent?.pending && going.agent.waits && <span data-board-head-agent-waits={going.agent.waits.kind}>{` · ${agentWaitsText(locale, nameOf(going), going.agent.waits)}`}</span>}
        {going && !going.agent?.pending && <span data-board-head-merging>{` · ${tr(locale, "boardHeadMerging", { key: nameOf(going) })}`}</span>}
        {/* C3: an agent resolves the conflict — its resolution run opens from here (it is on no link) */}
        {going?.agent?.pending && <span data-board-head-agent={going.agent.resolutionRunId}>{going.agent.waits ? " " : ` · ${tr(locale, "boardHeadAgent", { key: nameOf(going) })} `}
          <button type="button" data-board-head-agent-open onClick={() => openRun(going.agent!.resolutionRunId)}>{t(locale, "orchOpenRun")}</button></span>}
        <span className="board-card__header-actions">
          {keys.length > 0 && <button type="button" data-board-head-branch onClick={() => setAsking("branch")}>{t(locale, "boardHeadBranch")}</button>}
          {keys.length > 0 && <button type="button" data-board-head-apply onClick={() => setAsking("apply")}>{t(locale, "boardHeadApply")}</button>}
          <button type="button" data-board-head-new onClick={() => setAsking("new")}>{t(locale, "boardHeadNew")}</button>
        </span>
      </div>
      {asking && (
        <div className="board-task__confirm" role="alertdialog" data-board-head-confirm={asking}>
          <p>{asking === "update" ? tr(locale, "boardHeadUpdateWhy", { branch: head.branch ?? "HEAD" })
            : t(locale, asking === "branch" ? "boardHeadBranchWhy" : asking === "apply" ? "boardHeadApplyWhy" : "boardHeadNewWhy")}</p>
          <button type="button" className="orch-primary" data-board-head-yes onClick={() => void act(asking)}>
            {t(locale, asking === "branch" ? "boardHeadBranch" : asking === "apply" ? "boardHeadApply" : asking === "update" ? "boardHeadUpdate" : "boardHeadNew")}</button>
          <button type="button" onClick={() => setAsking(null)}>{t(locale, "orchCancel")}</button>
        </div>
      )}
      {behind > 0 && (
        <div className="board-card__head-line" data-board-head-behind={behind}>
          <span className="orch-hint orch-hint--warn">{tr(locale, `boardHeadBehind_${many}`, { n: behind })}</span>
          {!going && !waits && asking !== "update" && <button type="button" data-board-head-update onClick={() => setAsking("update")}>{t(locale, "boardHeadUpdate")}</button>}
        </div>
      )}
      {head.otherLine && <div className="board-card__head-line orch-hint orch-hint--warn" data-board-head-other-line>
        {tr(locale, "boardHeadOtherLine", { branch: head.branch ?? "HEAD" })}</div>}
      {notMerged.length > 0 && !going && !waits && (
        <div className="board-card__head-line" data-board-not-merged>
          <span>{tr(locale, "boardNotMerged", { keys: notMerged.map((x) => x.key).join(", ") })}</span>
          <button type="button" data-board-merge-all onClick={async () => { const f = failure(await board.mergeAll(workspaceId, head.project, language)); if (f) say(f); }}>{t(locale, "boardMergeAll")}</button>
        </div>
      )}
      {waits && (
        <div className="board-card__merge" role="alert" data-board-merge-waits={waits.reason ?? ""}>
          <strong>{tr(locale, "boardMergeWaits", { key: nameOf(waits), why: tr(locale, `boardMergeReason_${waits.reason}`) || String(waits.reason) })}</strong>
          {waits.conflicts.length > 0 && <p data-board-merge-conflicts>{tr(locale, "boardMergeConflictFiles", { files: waits.conflicts.join(", ") })}</p>}
          {waits.reason === "merge_checks_failed" && <p>{t(locale, "boardMergeChecksFailed")}</p>}
          {waits.reason === "merge_agent_failed" && <p data-board-merge-agent-why={waits.detail ?? ""}>{tr(locale, `boardMergeAgentWhy_${(waits.detail ?? "failed").split(":")[0]}`, { detail: agentWhyDetail(locale, waits.detail) }) || waits.detail}</p>}
          {waits.agent && <p>
            <button type="button" data-board-merge-agent-open onClick={() => openRun(waits.agent!.resolutionRunId)}>{t(locale, "boardMergeAgentOpen")}</button></p>}
          <p className="orch-hint">{t(locale, "boardMergeHow")}</p>
          {answer?.runId === waits.runId && <p className="orch-hint orch-hint--warn" data-board-merge-answer={answer.kind}>
            {tr(locale, answer.kind === "unresolved" ? "boardMergeUnresolved" : "boardMergeOutside", { files: answer.files.join(", ") })}</p>}
          <div className="board-task__actions">
            <button type="button" data-board-merge-open onClick={async () => { const f = failure(await board.openMerge(waits.runId)); if (f) say(f); }}>{t(locale, "boardMergeOpen")}</button>
            {answer?.runId === waits.runId && answer.kind === "confirm"
              ? <button type="button" className="orch-primary" data-board-merge-outside-yes onClick={() => void check(waits.runId, true)}>{t(locale, "boardMergeOutsideYes")}</button>
              : <button type="button" className="orch-primary" data-board-merge-check onClick={() => void check(waits.runId, false)}>{t(locale, "boardMergeCheck")}</button>}
            {!waits.source && TO_AGENT.has(waits.reason ?? "") && <button type="button" data-board-merge-agent
              onClick={async () => { setAnswer(null); const r = await board.toAgent(waits.runId, language); const f = failure(r); say(f ?? t(locale, "boardMergeAgentStarted")); }}>
              {t(locale, waits.agent ? "boardMergeAgentAgain" : "boardMergeAgent")}</button>}
            <button type="button" data-board-merge-skip onClick={async () => { setAnswer(null); const f = failure(await board.skip(waits.runId)); if (f) say(f); }}>{t(locale, "boardMergeSkip")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// F1 (stage-f-external-projects.md §10): the codes of the import window — one family, boardImportCode_<code>; the
// placeholders from the refused row (its ref, detail) and the file's own rows (the project of a ref). A dependency's
// refusal names the dependency: its ref is in the detail (boardStore: «dependsOn: no task X …», «dependsOn: X is refused»)
function importText(locale: LocaleId, code: string, detail = "", rowRef: string | null = null, tasks: InboxTask[] = []): string {
  const key = `boardImportCode_${code}`;
  const ref = code === "unknown_dependency" || code === "dependency_refused" ? /dependsOn: (?:no task )?([A-Za-z0-9][A-Za-z0-9-]*)/.exec(detail)?.[1] ?? "" : rowRef;
  if (!t(locale, key as TranslationKey)) return tr(locale, `orchError_${code}`) || detail || code;
  return tr(locale, key, { ref: ref ?? "", detail, field: /(\S+) is taken from stage/.exec(detail)?.[1] ?? "", name: /are named (.*)$/.exec(detail)?.[1] ?? "",
    path: tasks.find((x) => x.ref === ref)?.project ?? "" });
}
const reportLine = (locale: LocaleId, r: ImportReport) =>
  tr(locale, "boardImportReport", { file: r.file, c: r.created.length, u: r.updated.length, n: r.unchanged.length, r: r.refused.length });

// «Import tasks» and «Import»: what was created, updated, left unchanged and refused (a code and its words)
function ImportReportView({ locale, report, tasks }: { locale: LocaleId; report: ImportReport; tasks: InboxTask[] }): React.JSX.Element {
  return (
    <div className="board-import" data-board-import-report={report.status} data-wheel-owner="local">
      <p data-board-import-line>{reportLine(locale, report)}</p>
      <ul className="board-import__list">
        {report.created.map((x) => <li key={`c${x.ref}`} data-board-import-created={x.ref}>+ {x.ref} → {x.key}</li>)}
        {report.updated.map((x) => <li key={`u${x.ref}`} data-board-import-updated={x.ref}>~ {x.ref} → {x.key}</li>)}
        {report.unchanged.map((ref) => <li key={`n${ref}`} data-board-import-unchanged={ref}>= {ref}</li>)}
        {report.refused.map((x) => <li key={`r${x.ref}|${x.code}|${x.detail}`} className="orch-hint orch-hint--warn" data-board-import-refused={x.code} title={x.detail}>
          × {x.ref ? `${x.ref}: ` : ""}{importText(locale, x.code, x.detail, x.ref, tasks)}</li>)}
      </ul>
    </div>
  );
}

// F1 (§5.4, §10): a file of inbox/ — checked: its rows and «Import / Reject» (every row refused: «Reject» only);
// invalid_file, refused: its code, no decision (it is in done/ already)
function InboxLine({ locale, row, readOnly, onImport, onReject }: { locale: LocaleId; row: InboxRow; readOnly: boolean; onImport(): Promise<void>; onReject(): Promise<void> }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const r = row.report;
  const checked = r.status === "checked";
  const refused = new Map(r.refused.filter((x) => x.ref).map((x) => [x.ref, x]));
  const importable = r.created.length + r.updated.length + r.unchanged.length > 0;
  const act = (fn: () => Promise<void>) => async () => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  return (
    <div className="board-card__inbox" data-board-inbox={row.file} data-board-inbox-status={r.status}>
      <strong>{tr(locale, "boardInboxRow", { file: row.file, n: row.tasks.length, k: r.refused.length })}</strong>
      {!checked && r.code && <span data-board-inbox-code={r.code} title={r.refused[0]?.detail}>{` · ${importText(locale, r.code, r.refused[0]?.detail ?? "", null, row.tasks)}`}</span>}
      {checked && (
        <ul className="board-card__inbox-tasks">
          {row.tasks.map((x) => {
            const no = refused.get(x.ref);
            return (
              <li key={`${x.ref}|${x.title}|${x.project}`} data-board-inbox-task={x.ref} data-board-inbox-refused={no?.code} title={x.project}>
                <b>{x.ref}</b> {x.title} · {x.project}{x.external ? ` · ${t(locale, "boardExternal")}` : ""}{x.dependsOn.length ? ` · ${tr(locale, "boardAfter", { keys: x.dependsOn.join(", ") })}` : ""}
                {no && <span className="board-card__inbox-refused">{` · ${importText(locale, no.code, no.detail, no.ref, row.tasks)}`}</span>}
              </li>
            );
          })}
          {r.refused.filter((x) => !x.ref).map((x) => <li key={`f${x.code}|${x.detail}`} className="board-card__inbox-refused" data-board-inbox-refused={x.code}>{importText(locale, x.code, x.detail, null, row.tasks)}</li>)}
        </ul>
      )}
      {checked && !readOnly && (
        <span className="board-card__inbox-actions">
          <button type="button" className="orch-primary" data-board-inbox-import disabled={busy || !importable} onClick={act(onImport)}>{t(locale, "boardInboxImport")}</button>
          <button type="button" data-board-inbox-reject disabled={busy} onClick={act(onReject)}>{t(locale, "boardInboxReject")}</button>
        </span>
      )}
    </div>
  );
}
