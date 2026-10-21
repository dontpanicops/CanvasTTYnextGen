// F1 (docs/agent-orchestration/implementation/stage-f-external-projects.md §5.4): <userData>/orchestration/inbox/ — a
// board-tasks/v1 file put there by another process is only checked; tasks are written only by the person's «Import».
// The poll reads the top-level *.json (a writer puts <name>.json.tmp and renames it; reports/, done/, .work/ and any
// other folder are never walked), every 2 s and only while the application is open; after a restart every file is
// checked again (a report is state, not the source of what is shown). invalid_file and refused go to done/ at once with
// their report; «Import» and «Reject» take the file there too. Nothing here starts, deletes, accepts or merges anything.
// What moves to done/ is only the version that was read and checked: before reading, the file is renamed into .work/
// (out of a writer's reach, who may replace inbox/<name> at any moment) and only that copy is read, decided and moved.
// A copy still waiting goes back to inbox/ by link(), which never overwrites: a newer file that took the name meanwhile
// stays in inbox/ to be checked on its own, and the older copy goes to done/ as replaced (file_changed). After a
// restart what is left in .work/ is checked again the same way, so no version is lost.
import { link, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImportReport, InboxRow } from "../../../shared/taskBoard.ts";
import { fileRefusal, inboxTasks, readImportFile, sha256 } from "./boardImport.ts";

const JSON_NAME = /^[^/\0]+\.json$/;
// the name's stem up to 200 bytes of UTF-8: reports/<stem>.report.json and done/<stem>-<n>.report.json(.tmp) stay
// within a file name's 255 bytes
const STEM_MAX_BYTES = 200;
export const inboxNameOk = (name: string): boolean => JSON_NAME.test(name) && Buffer.byteLength(name.slice(0, -".json".length)) <= STEM_MAX_BYTES;
const POLL_MS = 2000;

export interface InboxDeps {
  dir: string;
  check(file: string, bytes: Uint8Array): Promise<ImportReport>;
  apply(file: string, bytes: Uint8Array, shown: ImportReport): Promise<{ report: ImportReport; changed: null | "file_changed" | "report_changed" }>;
  changed(): void; // a row came, changed or went: main tells the window (§5.6)
}

const refuse = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const exists = (path: string) => lstat(path).then(() => true, () => false);
const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

export function createInbox(d: InboxDeps) {
  const reports = join(d.dir, "reports");
  const done = join(d.dir, "done");
  const work = join(d.dir, ".work"); // the copy being read and decided: the poll never walks it
  const pending = new Map<string, InboxRow>(); // checked, waiting for the person (the file is in inbox/)
  const settled: InboxRow[] = []; // ponytail: invalid_file / refused shown until a restart, the last 20; a «dismiss» when asked for
  const longNames = new Set<string>(); // shown once as invalid_file, left in inbox/ unread (no done/ name fits them)
  let timer: ReturnType<typeof setInterval> | null = null;
  // one at a time: the poll and the person's decisions never move the same file at once
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  const stem = (file: string) => file.slice(0, -".json".length);
  const writeTmp = (path: string, value: unknown) => writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  async function writeJson(path: string, value: unknown): Promise<void> {
    await writeTmp(path, value);
    await rename(`${path}.tmp`, path);
  }
  // inbox/<file> into .work/ (a symbolic link itself, never its target); false: it is gone. A copy of that name still in
  // .work/ (a decision that failed midway while a newer file took its name) goes to done/ as replaced first: rename
  // would overwrite it.
  async function take(file: string): Promise<boolean> {
    await mkdir(work, { recursive: true, mode: 0o700 });
    const stuck = await lstat(join(work, file)).catch(() => null);
    const there = stuck && await lstat(join(d.dir, file)).catch(() => null);
    if (stuck && there && stuck.ino === there.ino && stuck.dev === there.dev) await rm(join(work, file)); // the same file already back
    else if (stuck) {
      const read = await readImportFile(join(work, file), file); // a symbolic link: its own refusal, the target unread
      await toDone(file, "bytes" in read ? fileRefusal(file, sha256(read.bytes), "file_changed", "a newer file took its name in inbox/ before a decision") : read.report);
    }
    try { await rename(join(d.dir, file), join(work, file)); return true; } catch (e) { if (errno(e) === "ENOENT") return false; throw e; }
  }
  // .work/<file> back to inbox/ unless a newer file has the name there now; false: it has (or the copy is gone). Only a
  // regular file goes back: link() follows a symbolic link on macOS, and its target must never reach inbox/.
  async function giveBack(file: string): Promise<boolean> {
    const copy = await lstat(join(work, file)).catch(() => null);
    if (!copy?.isFile()) return false;
    try { await link(join(work, file), join(d.dir, file)); } catch (e) {
      if (errno(e) !== "EEXIST") throw e;
      // the same file already back (an end between link and rm): only the copy's name goes
      const there = await lstat(join(d.dir, file)).catch(() => null);
      if (!there || there.ino !== copy.ino || there.dev !== copy.dev) return false;
    }
    await rm(join(work, file), { force: true });
    return true;
  }
  const rescue = (file: string) => giveBack(file).catch(() => false); // a failure midway: the copy is not left in .work/
  // .work/<file> and its report to done/; a taken name gets -2, -3, …
  async function toDone(file: string, report: ImportReport): Promise<void> {
    for (let n = 1; n < 10_000; n++) {
      const name = n === 1 ? stem(file) : `${stem(file)}-${n}`;
      if (await exists(join(done, `${name}.json`)) || await exists(join(done, `${name}.report.json`))) continue;
      // the file before its report: an end midway leaves no report without its file
      await writeTmp(join(done, `${name}.report.json`), report);
      await rename(join(work, file), join(done, `${name}.json`));
      await rename(join(done, `${name}.report.json.tmp`), join(done, `${name}.report.json`));
      break;
    }
    await rm(join(reports, `${stem(file)}.report.json`), { force: true });
  }
  const show = (row: InboxRow) => { settled.unshift(row); settled.length = Math.min(settled.length, 20); };
  // the copy in .work/ with its report: checked — back to inbox/ to wait for the person; anything else, or a newer file
  // in inbox/ meanwhile — to done/
  async function settle(file: string, report: ImportReport, bytes: Uint8Array | null): Promise<void> {
    if (report.status === "checked") {
      if (await giveBack(file)) {
        pending.set(file, { file, sha256: report.sha256, workspaceId: report.workspaceId, report, tasks: bytes ? inboxTasks(bytes) : [] });
        await writeJson(join(reports, `${stem(file)}.report.json`), report);
        return;
      }
      report = fileRefusal(file, report.sha256, "file_changed", "a newer file took its name in inbox/ before a decision", report.workspaceId);
    }
    pending.delete(file);
    await toDone(file, report);
    // the window it shows in: the file's workspace; a closed or unknown one (workspace_unavailable) — the active one, as
    // when the workspace cannot be told at all (§5.4)
    show({ file, sha256: report.sha256, workspaceId: report.code === "workspace_unavailable" ? null : report.workspaceId, report, tasks: bytes ? inboxTasks(bytes) : [] });
  }
  // the copy in .work/ read and checked (nothing written to the board), then settled
  async function checkCopy(file: string): Promise<void> {
    try {
      const read = await readImportFile(join(work, file), file);
      const bytes = "bytes" in read ? read.bytes : null;
      await settle(file, bytes ? await d.check(file, bytes) : (read as { report: ImportReport }).report, bytes);
    } catch (e) { await rescue(file); throw e; }
  }
  // a new or changed file: taken and checked; the same one as shown: left as it is
  async function examine(file: string): Promise<boolean> {
    const read = await readImportFile(join(d.dir, file), file);
    if ("bytes" in read && pending.get(file)?.sha256 === sha256(read.bytes)) return false;
    if (!(await take(file))) return false;
    await checkCopy(file);
    return true;
  }
  // a name too long for reports/ and done/: shown once as invalid_file (the report only in memory), the file not read
  function tooLong(file: string): boolean {
    if (longNames.has(file)) return false;
    longNames.add(file);
    show({ file, sha256: sha256(new Uint8Array()), workspaceId: null, tasks: [],
      report: fileRefusal(file.slice(0, 255), sha256(new Uint8Array()), "invalid_file", `the name is over ${STEM_MAX_BYTES} bytes before .json`) });
    return true;
  }
  const scan = () => serial(async () => {
    const entries = await readdir(d.dir, { withFileTypes: true }).catch(() => []);
    const all = entries.filter((e) => !e.isDirectory() && JSON_NAME.test(e.name)).map((e) => e.name);
    const names = all.filter(inboxNameOk);
    let moved = false;
    for (const gone of [...pending.keys()].filter((f) => !names.includes(f))) { // taken away by its writer
      pending.delete(gone);
      await rm(join(reports, `${stem(gone)}.report.json`), { force: true });
      moved = true;
    }
    for (const f of [...longNames].filter((x) => !all.includes(x))) longNames.delete(f);
    for (const file of all.filter((f) => !inboxNameOk(f))) moved = tooLong(file) || moved;
    // a copy left in .work/ by a decision that failed midway (done/ not writable, a symbolic link), its name free in
    // inbox/: checked again each time until it is back or filed
    for (const e of await readdir(work, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() && inboxNameOk(e.name) && !all.includes(e.name)) moved = (await checkCopy(e.name).then(() => true, () => false)) || moved;
    }
    for (const file of names) moved = (await examine(file).catch(() => false)) || moved; // gone meanwhile, unreadable: next time
    if (moved) d.changed();
  });
  // after a restart: a copy left in .work/ midway is checked again (back to inbox/, or to done/ as replaced)
  const recover = () => serial(async () => {
    // a report left as .tmp by an end between filing the file and naming its report
    for (const f of await readdir(done).catch(() => [] as string[])) {
      const base = f.endsWith(".report.json.tmp") ? f.slice(0, -".report.json.tmp".length) : null;
      if (base && await exists(join(done, `${base}.json`)) && !(await exists(join(done, `${base}.report.json`)))) await rename(join(done, f), join(done, `${base}.report.json`)).catch(() => {});
    }
    for (const e of await readdir(work, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() && inboxNameOk(e.name)) await checkCopy(e.name).catch(() => {});
    }
  });
  // a decision on a row: its file taken into .work/; gone — the row goes, file_changed
  async function takeRow(file: string): Promise<void> {
    if (await take(file)) return;
    pending.delete(file);
    await rm(join(reports, `${stem(file)}.report.json`), { force: true });
    d.changed();
    refuse("file_changed", "the file is gone from inbox/");
  }

  return {
    async start(): Promise<void> {
      if (timer) return;
      for (const dir of [d.dir, reports, done, work]) await mkdir(dir, { recursive: true, mode: 0o700 });
      timer = setInterval(() => void scan(), POLL_MS);
      timer.unref?.();
      await recover();
      await scan();
    },
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      await chain;
    },
    scan,
    rows: (): InboxRow[] => [...pending.values(), ...settled],
    // «Import»: the file read again (the copy taken into .work/); another hash than the shown one — file_changed and the
    // new check; the board moved on since — the new report waits for a second «Import» (§5.4)
    import: (file: string, sha: string) => serial(async (): Promise<ImportReport> => {
      const row = pending.get(file);
      if (!row || row.sha256 !== sha) refuse("file_changed", "the file is not the one shown");
      const r = row!.report;
      if (!r.created.length && !r.updated.length && !r.unchanged.length) refuse("invalid_argument", "every row of the file is refused: only «Reject»");
      await takeRow(file);
      try {
        const read = await readImportFile(join(work, file), file);
        if ("report" in read) {
          await settle(file, read.report, null);
          d.changed();
          return refuse("file_changed", "the file changed after the check");
        }
        const applied = await d.apply(file, read.bytes, r);
        if (applied.changed === null) {
          pending.delete(file);
          await toDone(file, applied.report);
        } else await settle(file, applied.report, read.bytes);
        d.changed();
        if (applied.changed === "file_changed") refuse("file_changed", "the file changed after the check: it was checked again");
        return applied.report;
      } catch (e) { await rescue(file); throw e; }
    }),
    // «Reject»: only the version shown is rejected; another one is checked again (file_changed)
    reject: (file: string) => serial(async (): Promise<null> => {
      const row = pending.get(file);
      if (!row) refuse("file_changed", "the file is not the one shown");
      await takeRow(file);
      try {
        const read = await readImportFile(join(work, file), file);
        if ("bytes" in read && sha256(read.bytes) === row!.sha256) {
          pending.delete(file);
          await toDone(file, { ...row!.report, status: "rejected", at: new Date().toISOString() });
          d.changed();
          return null;
        }
        await settle(file, "bytes" in read ? await d.check(file, read.bytes) : read.report, "bytes" in read ? read.bytes : null);
        d.changed();
        return refuse("file_changed", "the file changed after the check: it was checked again");
      } catch (e) { await rescue(file); throw e; }
    })
  };
}
