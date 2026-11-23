[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/azkia13/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/azkia13/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all of them:

- **unified diffs** (often with wrong line numbers),
- **SEARCH/REPLACE blocks**,
- **V4A patches** (`*** Begin Patch` ... `*** End Patch`),
- **JSON tool calls** (`create`, `str_replace`, `insert`).

Every file is changed or nothing is: a failed edit is reported and the rest
still run, and when any edit fails no file is written at all.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Matching

Old lines are found at the first of three tiers at which they occur at
least once: exact, trailing whitespace ignored, then leading and trailing
whitespace ignored (with re-indentation of the new lines). Unified hunks
take the occurrence nearest their stated line number; SEARCH/REPLACE blocks
fail as ambiguous when the old lines occur more than once; V4A chunks walk
a cursor through the file, anchored by `@@` lines.

## Output

- Exit 0: one line per changed path (`A` added, `D` deleted, `M` modified,
  `R old -> new` moved), then `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then
  `failed: <k> of <n> edits`. No file is written.
- Exit 2: a single `error: usage`, `error: no-patch`, `error: format` or
  `error: parse <N>` line.

Node 22, standard library only. `runner.ts` is the kit's trial runner and is
kept as it is; `main.ts` hands a trial over to it when `MAKEFUN_ENV_URL` is
set.
