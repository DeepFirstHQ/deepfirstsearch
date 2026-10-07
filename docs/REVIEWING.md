# Reviewing outside contributions

This code moves money, so every outside pull request goes through the same four gates before it is merged. No exceptions for small or friendly-looking changes.

## 1. PR guard (automatic, can't be edited by the PR)

`.github/workflows/pr-guard.yml` runs on `pull_request_target`, which means the workflow and `scripts/pr-guard/guard.mjs` always come from `main`. A pull request can't change or disable its own checks. It reads the PR's diff **as data** and never installs or runs anything from it.

- **Blocks outright** (a maintainer has to rewrite that part): invisible or bidirectional Unicode, install/publish lifecycle scripts, symlinks, binaries, files over 256 KiB, long encoded blobs, minified lines.
- **Blocks until a maintainer approves:**
  - sensitive paths: `.github/`, `package.json`, lockfiles, build configs, contracts, signing/policy/wallet code, integration runtime code, scripts;
  - dangerous APIs in added lines: process execution, `eval`/`new Function`, computed imports, requests to outside hosts, raw sockets, home directory, credentials or keys, unexpected environment variables, decoding hidden strings, filesystem writes.

**Approval** is the `maintainer-approved` label, added after reviewing the **exact head commit**. Any new push removes the label automatically, so approved code can't be swapped.

## 2. Tests in CI (sandboxed)

`ci.yml` runs on `pull_request`: an ephemeral GitHub runner, no secrets, read-only token. Nothing is published from a PR; npm releases only come from tags pushed by maintainers.

## 3. Line-by-line review

- Read every changed line, including tests, fixtures, docs code blocks and lockfile diffs.
- Check that the tests really exercise the change: revert the fix mentally (or in a sandbox) and the test should fail.
- Be extra careful with: anything that touches signing, payees, amounts or limits; error handling that could turn a refusal into a payment; new dependencies (typosquats, maintainer history); and "drive-by" edits outside the issue's scope.
- AI-assisted PRs are fine, but the author must be able to explain the change. Several accounts showing up on new `good first issue`s within minutes of each other is normal noise, not trust.

## 4. If you must run a PR locally

Never check it out in your normal working tree (it holds untracked `private/` files and your keys are under your home directory). Use:

```bash
scripts/pr-guard/sandbox-test.sh <PR number> <package dir>   # e.g. 17 sdk
```

It clones into a throwaway directory under `/tmp`, runs the guard from `main`, installs with `--ignore-scripts`, and runs the tests under macOS `sandbox-exec`:
- no network except localhost;
- no reads of your home directory;
- no writes outside the throwaway clone and temp dirs.

It was verified to block reading `private/`, `~/.ssh` and Foundry keystores, internet requests (by name or IP), and writes to the home directory and `/opt/homebrew`.

## Merge

Merge only when all four are green: guard passed (with approval if needed), CI passed, review done, and the approval is on the current head commit. Squash-merge, so the history shows one reviewed change.
