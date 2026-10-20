// Notifications and the Dock badge for the runs this window watches (every link's latest run, in every workspace).
// What to tell is notify.ts; here it reaches macOS (main shows it) or, where macOS shows nothing, a banner in the window.
import { useCallback, useEffect, useRef, useState } from "react";
import type { LocaleId, NotificationSettings } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import { NOTIFIED_KEY, NOTIFY_UNAVAILABLE_KEY, boardHeadNotes, boardNotes, notifyStep, pruneNotified, splitNotes, type Note } from "./notify";
import type { AutopilotState, BoardHead, BoardView } from "../../../../shared/taskBoard";
import type { RunActivityState, RunState } from "./useOrchestration";

const store = {
  read(): Record<string, string> {
    try { const v = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
  },
  write(v: Record<string, string>): void { try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(pruneNotified(v))); } catch { /* not kept: at worst one repeat after a restart */ } },
  unavailable(): boolean { try { return localStorage.getItem(NOTIFY_UNAVAILABLE_KEY) === "1"; } catch { return false; } },
  setUnavailable(): void { try { localStorage.setItem(NOTIFY_UNAVAILABLE_KEY, "1"); } catch { /* the banner still shows */ } }
};

const NO_AUTOPILOT: Record<string, AutopilotState> = {};
const NO_HEADS: BoardHead[] = [];
const projectName = (project: string): string => project.split("/").filter(Boolean).at(-1) ?? "Raoden Loom";
export function useRunNotifications({ locale, prefs, runs, activity, title, open, accepting = 0, autopilot = NO_AUTOPILOT, boardPlace = () => "", heads = NO_HEADS, board: boardView = null }: {
  locale: LocaleId; prefs: NotificationSettings; runs: Record<string, RunState>; activity: Record<string, RunActivityState>;
  title(runId: string): string; open(runId: string): void;
  accepting?: number; // the board's tasks waiting for «Accept the result» (counted on the badge)
  autopilot?: Record<string, AutopilotState>; boardPlace?(linkId: string): string; // B4: the board's autopilot of each link
  heads?: BoardHead[]; // C4: the board's merged heads (their merges waiting for the person, the head moving)
  board?: Pick<BoardView, "board" | "facts"> | null; // E4: the decomposition runs wait for the person (their own notes and badge, not the runs')
}): { banner: Note[]; openNote(runId: string): void; dismiss(runId: string): void } {
  const notified = useRef<Record<string, string> | null>(null);
  const badge = useRef<number | null>(null);
  const [banner, setBanner] = useState<Note[]>([]);
  const shown = useRef(new Map<string, Note>());
  const toBanner = useCallback((n: Note) => setBanner((b) => [...b.filter((x) => x.runId !== n.runId), n]), []);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    notified.current ??= store.read();
    const splitRuns = new Set((boardView?.facts ?? []).filter((f) => f.decompositionOf).map((f) => f.runId));
    const list = Object.entries(runs).filter(([runId]) => !splitRuns.has(runId)).map(([runId, r]) => ({ runId, view: r.view, place: title(runId), entries: activity[runId]?.entries ?? [] }));
    const focused = document.hasFocus() && !document.hidden;
    const step = notifyStep(locale, list, notified.current, prefs, focused, true, accepting);
    const board = boardNotes(locale, autopilot, step.notified, prefs, focused, boardPlace);
    const head = boardHeadNotes(locale, heads, autopilot, board.notified, prefs, focused, projectName);
    const split = boardView ? splitNotes(locale, boardView.board, boardView.facts, heads, head.notified, prefs, focused, projectName) : { notes: [], notified: head.notified, waiting: 0 };
    step.notes.push(...board.notes, ...head.notes, ...split.notes);
    notified.current = split.notified;
    store.write(split.notified);
    const count = step.badge + (prefs.dockBadge ? head.waiting + split.waiting : 0); // C4: a merge waiting for the person is the person's too
    if (badge.current !== count) { badge.current = count; window.canvasTTY.notify.setBadge(count); }
    if (step.bounce) window.canvasTTY.notify.bounce();
    for (const n of step.notes) {
      if (store.unavailable()) { toBanner(n); continue; }
      shown.current.set(n.runId, n);
      void window.canvasTTY.notify.show(n).then((r) => { if (!r.shown) { store.setUnavailable(); toBanner(n); } }, () => toBanner(n));
    }
  }, [accepting, activity, autopilot, boardPlace, boardView, heads, locale, prefs, runs, title, toBanner]);

  useEffect(() => {
    const offClick = window.canvasTTY.notify.onClick((runId) => openRef.current(runId));
    // macOS refused it (no permission, an ad-hoc signed build): the settings say how to allow them; the banner meanwhile
    const offFailed = window.canvasTTY.notify.onFailed((runId) => { store.setUnavailable(); const n = shown.current.get(runId); if (n) toBanner(n); });
    return () => { offClick(); offFailed(); };
  }, [toBanner]);

  const dismiss = useCallback((runId: string) => setBanner((b) => b.filter((x) => x.runId !== runId)), []);
  return { banner, dismiss, openNote: useCallback((runId: string) => { dismiss(runId); openRef.current(runId); }, [dismiss]) };
}

export function NotifyBanner({ locale, notes, onOpen, onDismiss }: { locale: LocaleId; notes: Note[]; onOpen(runId: string): void; onDismiss(runId: string): void }): React.JSX.Element | null {
  if (!notes.length) return null;
  return (
    <div className="notify-banner" role="status" data-interactive="true" data-notify-banner>
      {notes.map((n) => (
        <div key={n.runId} className={`notify-banner__item notify-banner__item--${n.signal}`} data-notify-run={n.runId}>
          <span><b>{n.title}</b> {n.body}</span>
          <button type="button" onClick={() => onOpen(n.runId)}>{t(locale, "orchNotifyBannerOpen")}</button>
          <button type="button" aria-label={t(locale, "orchNotifyBannerClose")} onClick={() => onDismiss(n.runId)}>×</button>
        </div>
      ))}
    </div>
  );
}
