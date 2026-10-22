# Audits & security reviews

This folder holds the security material for Agent Safe: the audit scope, our own
pre-audit, and completed third-party reviews.

| Document | What |
|---|---|
| [SCOPE.md](./SCOPE.md) | What's in scope, nSLOC, roles, known issues, and questions for reviewers. The commit to audit is the **`audit-v1`** tag. |
| [PREAUDIT-2026-10.md](./PREAUDIT-2026-10.md) | Our internal pre-audit (Oct 2026): every finding, fixed with its test or acknowledged with the reason. |

## Completed third-party reviews

_None published yet._

<!-- When one lands, add a row:
| [<firm> — <yyyy-mm>](./<firm>-<yyyy-mm>.pdf) | <scope reviewed> · commit `<tag/sha>` · <findings: n, all resolved / see notes> |
-->

## Adding a review to this folder

A reviewer or firm with a completed report is very welcome here. The process keeps users
safe and gives you clear attribution:

1. **Send the report privately first.** If it contains any unresolved finding, email
   **security@deepfirstsearch.com** or open a [private advisory](https://github.com/DeepFirstHQ/deepfirstsearch/security/advisories/new).
   We acknowledge within 24h and agree a disclosure date with you (see [SECURITY.md](../../SECURITY.md)).
   Nothing with a live, unfixed issue goes public before it's addressed.
2. **Then it lands here.** Once findings are resolved or a disclosure date is set, the
   report is added as `docs/audit/<firm>-<yyyy-mm>.pdf` (a `.md` summary is also welcome)
   with one row in the table above. Either **open a PR** with the file and the row (see
   [CONTRIBUTING.md](../../CONTRIBUTING.md)), or send us the file and we'll add it with
   your attribution.
3. **Tell us how to credit you** — name/handle, link, the commit or tag you reviewed, and
   whether anything is time-embargoed.

The repository is public and MIT-licensed, so a fork-and-PR works without any special access.
