# Task board exchange formats

Two public JSON formats connect the Raoden Loom task board with the tools around it:

- `board-tasks/v1` — a tasks file that a person or a script hands to the board (schema: [`docs/board-tasks-v1.schema.json`](../board-tasks-v1.schema.json)); the board answers with a report, `board-tasks-report/v1`.
- `board-review/v1` — the review export of a finished task run (schema: [`docs/board-review-v1.schema.json`](../board-review-v1.schema.json)).

Both schemas are JSON Schema draft 2020-12 and strict (`additionalProperties: false` everywhere). They use no `format` keyword, only `pattern`, and need a validator with full 2020-12 support (for example Ajv 8 with `ajv/dist/2020`, options `strict: true, strictRequired: false, allErrors: true`). A format changes only through a new version (`.../v2`).

Loom knows nothing about the project that produces the tasks file or consumes the review; everything project-specific lives on the side of the project.

## 1. `board-tasks/v1`

A tasks file is a JSON object in UTF-8, up to 1 MB. The file name is free (`tasks.json` is the usual one). Unknown fields are refused: at the top level the whole file (`invalid_file`), in a task that row (`invalid_task`).

| Field | Type | Required | Rule |
|---|---|---|---|
| `format` | `"board-tasks/v1"` | yes | any other value: `invalid_file` |
| `workspaceId` | string `^[A-Za-z0-9_-]{1,64}$` | one of the two | id of a workspace; closed or unknown workspace: `workspace_unavailable` |
| `workspace` | string, 1..200 | one of the two | name of an open workspace; no match or closed: `workspace_not_found`, more than one match: `workspace_ambiguous` (the whole file). Both fields together are `invalid_file` |
| `source` | string, up to 300 | no | where the tasks come from (for example `plan.md@<sha>`); goes to the report and to the task's `origin` |
| `tasks` | array, 1..200 | yes | |
| `tasks[].ref` | string `^[A-Za-z0-9][A-Za-z0-9-]{0,31}$` | yes | unique in the file and in the workspace; the key of an update |
| `tasks[].project` | absolute path: `^/`, up to 4096 | yes | must exist and be the root of a git repository; tasks of one file may belong to different projects of the workspace |
| `tasks[].title` | string, 1..200 | yes | |
| `tasks[].text` | string, 1..8000 | yes | |
| `tasks[].criteria` | array 1..32 of strings 1..500 | yes, except for `external` tasks | acceptance criteria; Loom does not make them up |
| `tasks[].dependsOn` | array of refs, unique, up to 64 | no | a ref from the file or an existing task of the workspace |
| `tasks[].ifAbsent` | `true` | no | create the task only if there is none; an existing one is left as it is. Not stored |
| `tasks[].external` | `true` | no | a task without a run; a person marks it done |
| `tasks[].models` | object `{lead?, executor?, reviewer?}` | no | a model per role, strings `^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$`, up to 128; no key: the model of the project profile; `null` is not accepted |
| `tasks[].issue` | string `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` | no | an external id of the task (tracker, ticket); Loom does not interpret it |
| `tasks[].commitTitle` | string, 1..72, no line breaks or control characters | no | title of the task's commit |
| `tasks[].scope` | array 1..64 of strings 1..300 | no | the area of the task; goes to the review export, Loom does not check it |

### Which Loom version accepts which field

The schema describes the whole format. A Loom version that does not yet know a field refuses the row with `field_not_supported`; a file without the field removes it from an existing task.

F1–F4 are the four steps of Loom's stage F, the one that brings in this format; the CHANGELOG names the Loom release that ships each step. A Loom without a step refuses the rows that use its fields.

| Fields | Accepted since |
|---|---|
| `format`, `workspaceId`/`workspace`, `source`, `tasks`, `ref`, `project`, `title`, `text`, `criteria`, `dependsOn`, `ifAbsent` | F1 |
| `external`, `models` | F2 |
| `issue`, `commitTitle` | F3 |
| `scope` | F4 |

### Lengths

`maxLength` and `minLength` in the schema count Unicode characters (code points). The import counts UTF-16 units of the string as it is, and it trims a string only to check that it is not empty. So a schema pass is not an acceptance: a string of spaces, or a string of characters outside the basic plane at the limit, passes the schema and is refused by the import (`invalid_task`). The answer is the import's refusal in the report.

### Examples

The schema checks both examples as they are. `project` is a placeholder; a real file names an existing repository.

The minimal example uses only the fields of F1:

<!-- example: tasks-minimal -->
```json
{ "format": "board-tasks/v1", "workspace": "acme",
  "tasks": [
    { "ref": "T1", "project": "/path/to/project", "title": "First task", "text": "…", "criteria": ["…"] } ] }
```

The full example uses every field. The chain: `T1` is an ordinary task, `T1-MR` is an external task "the merge request of T1 is merged" that depends on `T1`, `T2` depends on `T1-MR`:

<!-- example: tasks-full -->
```json
{ "format": "board-tasks/v1", "workspace": "acme", "source": "plan.md@<sha>",
  "tasks": [
    { "ref": "T1", "project": "/path/to/project", "title": "First task", "text": "…", "criteria": ["…"],
      "issue": "ISSUE-1", "commitTitle": "feat: first task" },
    { "ref": "T1-MR", "project": "/path/to/project", "title": "MR of T1 merged", "text": "…",
      "dependsOn": ["T1"], "external": true, "ifAbsent": true },
    { "ref": "T2", "project": "/path/to/project", "title": "Second task", "text": "…", "criteria": ["…", "…"],
      "dependsOn": ["T1-MR"], "issue": "ISSUE-1", "commitTitle": "feat: second task",
      "scope": ["docs/**"], "models": { "executor": "opus" } } ] }
```

### Update rules

- The file is checked as a whole, then all valid rows are written in one change, then a report is made. A refused row refuses the rows that depend on it (`dependency_refused`).
- A task with the same `ref` is updated: `title`, `text`, `criteria`, `dependsOn` and the later fields are replaced. An optional field that the file does not have (`issue`, `external`, `models`, `scope`, `commitTitle`) is removed from the existing task. A changed `project` is `project_changed`. A task that already has runs is not changed (`task_started`; an identical row is `unchanged`). An archived task with the same `ref` is `task_archived`. A task that was split is `task_split`.
- `ifAbsent: true`: no task with the `ref` — it is created; an existing one (not archived) is `unchanged` without comparing fields; an archived one is `task_archived`.
- New tasks are added in file order after the existing ones.

### Refusal codes

| Code | Level | When |
|---|---|---|
| `invalid_file` | file | not JSON, not an object, over 1 MB, `format` is not `board-tasks/v1`, an unknown top-level field, both `workspaceId` and `workspace`, a symbolic link |
| `workspace_not_found` / `workspace_ambiguous` | file | no open workspace has the name / several have |
| `workspace_unavailable` | file | `workspaceId` of a closed or unknown workspace |
| `board_unavailable` / `board_newer_version` | file | the board is read-only |
| `unsupported_platform` | file | the import is available on macOS arm64 only |
| `file_changed` | file | the file changed between the check and the person's "Import" |
| `too_many_tasks` | file | the board would exceed its limit |
| `invalid_ref` / `duplicate_ref` | row | the `ref` does not match its pattern / repeats in the file |
| `invalid_task` | row | the row breaks a rule of the table above (including lengths in UTF-16 units) or has an unknown field |
| `no_criteria` | row | a task that is not external has no criteria |
| `project_not_found` | row | the path is not absolute, does not exist, or is not the root of a git repository |
| `unknown_dependency` / `dependency_refused` | row | a `dependsOn` ref exists nowhere / the dependency was refused |
| `task_cycle` | row | a dependency cycle (every task of the cycle) |
| `field_not_supported` | row | a field of a later Loom version |
| `task_started` / `task_archived` / `task_split` | row | see the update rules |
| `project_changed` | row | an existing task has another `project` in the file |

### Report `board-tasks-report/v1`

For a file the board writes a report, `<file name>.report.json`; the import window shows the same object. There is no schema file for the report; it is described by this table.

| Field | Type | Nullable | Rule |
|---|---|---|---|
| `format` | string | no | `"board-tasks-report/v1"` |
| `file` | string | no | file name, 1..255 characters |
| `sha256` | string | no | hash of the file content, `^[0-9a-f]{64}$` |
| `at` | string | no | ISO-8601 UTC with milliseconds and `Z` |
| `status` | string | no | `checked`, `imported`, `rejected`, `invalid_file` or `refused` |
| `code` | string | yes | a refusal code; set only for `refused` and `invalid_file`, otherwise `null` |
| `workspaceId` | string | yes | the workspace of the file; `null` when it cannot be determined |
| `created`, `updated` | array of `{ref, key}` | no | `ref` matches the ref pattern, `key` matches `^T-\d{1,6}$`; `[]` when none |
| `unchanged` | array of string | no | refs left as they were; `[]` when none |
| `refused` | array of `{ref, code, detail}` | no | refused rows; `ref` is a string, or `null` for a refusal of the whole file (which also appears as `code`); `code` is a refusal code; `detail` is a string up to 400 characters |

## 2. `board-review/v1`

The review export is written for a finished run of a board task, outside the working tree (so it does not dirty the tree and does not change the revision). It is available from Loom F4; the schema is published earlier so that a consumer can be built and tested first. The export is `review.json`, with `review.md` next to it for a person.

General rules: objects are closed; every listed field is always present — "no value" is `null` or `[]` as the table says; every string has a `maxLength`, and a string with a form has a `pattern`.

Forms: a sha is `^([0-9a-f]{40}|[0-9a-f]{64})$` (SHA-1 or SHA-256 repository); `run` is a UUID; `at` is ISO-8601 UTC with milliseconds and `Z`; a git name (remote, branch) is `^(?!-)[A-Za-z0-9._/-]{1,200}$`; a task key is `^T-\d{1,6}$`.

Top level:

| Field | Type | Nullable | Meaning |
|---|---|---|---|
| `format` | `"board-review/v1"` | no | |
| `run` | string (UUID) | no | id of the run |
| `task` | object | no | the task (below) |
| `commit` | sha | no | the commit of the run |
| `tree` | sha | no | the tree of that commit |
| `checkedTree` | sha | no | the tree that was checked; differs from `tree` when files were left out of the commit |
| `base` | object | no | the base the run started from (below) |
| `branch` | git name | no | the branch of the run |
| `push` | object | yes | the push (below); `null` when no push was asked for or the person declined it |
| `lead`, `executor`, `reviewer` | object | yes | the role (below). `lead` is `null` only for a resolution run; `reviewer` is `null` when there was no reviewer turn |
| `conditions` | array | no | readiness conditions; `[]` when none |
| `findings` | array | no | the reviewer's findings; `[]` when none |
| `openBlocking` | integer ≥ 0 | no | open blocking findings in `findings` |
| `scope` | array of 1..300-character strings, up to 64 | yes | the `scope` of the task; `null` when the task has none |

`task`:

| Field | Type | Nullable | Meaning |
|---|---|---|---|
| `key` | string | no | the task key, `T-<n>` |
| `ref` | string (ref pattern) | yes | the `ref` of the task; `null` for a task without one |
| `title` | string, 1..200 | yes | `null` when the task was deleted from the board |
| `issue` | string (issue pattern) | yes | `null` for a task without `issue` and for a deleted one |

`base`: `branch` — `<remote>/<branch>`, `^[A-Za-z0-9._/-]{1,200}$`; `commit` — sha. Neither is `null`.

`push`: `remote` — git name; `at` — ISO-8601 time of the confirmed push; `result` — always `"confirmed"` (a finished run has a confirmed push).

Role:

| Field | Type | Nullable | Meaning |
|---|---|---|---|
| `provider` | `claude` or `codex` | no | provider of the role's turn |
| `cli` | `claude` or `codex` | no | the CLI of the provider; equal to `provider` in v1 |
| `model` | string (up to 128) | yes | the model alias of the role from the run's goal; `null` is the CLI's default model |
| `modelActual` | string (up to 128) | yes | the model that really answered; reserved, always `null` in v1 |
| `cliVersionAtExport` | semver string | yes | the CLI version **at export time, not at the turn**: the first word of the first line of `<cli> --version`, `^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$`; `null` when not read or not recognized |
| `cliVersionRaw` | string (up to 128) | yes | the first line of `<cli> --version` as it is, cut to 128 characters; `null` when not read |

Condition:

| Field | Type | Nullable | Meaning |
|---|---|---|---|
| `id` | string `^C[0-9]{1,6}$` | no | |
| `text` | string, 1..500 | no | |
| `covers` | array of `^R[0-9]{1,6}$`, up to 32 | no | requirements of the goal the condition covers |
| `stage` | integer ≥ 1 | no | |
| `status` | `met`, `not_met`, `not_checked`, `dropped` | no | |
| `stale` | boolean | no | `false` when the evidence is not stale |
| `evidence` | object `{kind, check, command}` | no | `kind` is `check`, `change` or `person`. For `check`: `check` is `^cmd-[0-9]{1,2}$` and `command` is a string (1..1000) or `null`. For the other kinds both are `null` |

Finding:

| Field | Type | Nullable | Meaning |
|---|---|---|---|
| `id` | string `^F[0-9]{1,6}$` | no | |
| `severity` | `blocking` or `wish` | no | |
| `status` | `open` or `closed` | no | |
| `closedBy` | `reviewer` or `person` | yes | `null` while the finding is open, a string once closed |
| `downgraded` | boolean | no | a person made a blocking finding a wish; the original severity is visible only here |
| `problem` | string, 1..2000 | no | |
| `evidence` | string, 0..2000 | no | |
| `closeWhen` | string, 1..1000 | no | |
| `paths` | array of strings 1..500 | no | `[]` when none |

An example of `review.json`:

<!-- example: review -->
```json
{ "format": "board-review/v1",
  "run": "0b9f1c52-3d9a-4c1e-9a55-6f0c2d7a8e11",
  "task": { "key": "T-2", "ref": "T2", "title": "Second task", "issue": "ISSUE-1" },
  "commit": "3f786850e387550fdab836ed7e6dc881de23001b",
  "tree": "9c1185a5c5e9fc54612808977ee8f548b2258d31",
  "checkedTree": "9c1185a5c5e9fc54612808977ee8f548b2258d31",
  "base": { "branch": "upstream/stable", "commit": "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" },
  "branch": "ISSUE-1-T2",
  "push": { "remote": "upstream", "at": "2026-10-21T10:15:30.000Z", "result": "confirmed" },
  "lead": { "provider": "claude", "cli": "claude", "model": "opus", "modelActual": null,
            "cliVersionAtExport": "2.1.0", "cliVersionRaw": "2.1.0 (Claude Code)" },
  "executor": { "provider": "claude", "cli": "claude", "model": "opus", "modelActual": null,
                "cliVersionAtExport": "2.1.0", "cliVersionRaw": "2.1.0 (Claude Code)" },
  "reviewer": { "provider": "codex", "cli": "codex", "model": null, "modelActual": null,
                "cliVersionAtExport": "0.155.0", "cliVersionRaw": "codex-cli 0.155.0" },
  "conditions": [
    { "id": "C1", "text": "The project checks pass", "covers": ["R1"], "stage": 1, "status": "met", "stale": false,
      "evidence": { "kind": "check", "check": "cmd-1", "command": "make lint" } } ],
  "findings": [
    { "id": "F1", "severity": "wish", "status": "closed", "closedBy": "reviewer", "downgraded": false,
      "problem": "Typo in the heading", "evidence": "docs/a.md:3", "closeWhen": "The heading is corrected",
      "paths": ["docs/a.md"] } ],
  "openBlocking": 0,
  "scope": ["docs/**"] }
```

`review.md` carries the same data for a person: a header (task, commit, roles), the conditions, and a table of findings ("no findings" for `[]`). It has no labels, verdict or vocabulary of any project; turning the export into a record of its own process is the project's job.
