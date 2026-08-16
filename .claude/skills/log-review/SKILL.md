---
name: log-review
description: Walk through builder's-log drafts one at a time — keep, cut, or correct each — and promote the kept ones into docs/DECISIONS.md. Use when the user types /log-review, or says "review the drafts", "clear the log backlog", "promote the decisions".
disable-model-invocation: true
---

# /log-review — promote drafts into the log

`docs/DECISIONS.draft.md` is a holding pen. `docs/DECISIONS.md` is the record.
Nothing crosses without the user saying so, one entry at a time.

## Steps

### 1. Read both files

Read `docs/DECISIONS.draft.md` and `docs/DECISIONS.md`.

If the draft file is missing or has no entries, say "No drafts to review" and
stop. Do not go looking for decisions to write up — that is `/log`'s job.

Tell the user how many drafts are waiting before you start.

**Done when:** the draft count is known and reported.

### 2. Walk them one at a time

**One entry per turn. Never batch.** Print the entry in full, exactly as
written, then stop and wait.

Before waiting, flag anything that needs the user's eye:

- **Every `INFERRED` line, called out explicitly.** Say: "Line marked INFERRED —
  I reconstructed this, you did not say it. Correct or confirm." This is the
  single most important thing this skill does. An inferred rationale that gets
  promoted unchallenged becomes a false memory in the permanent record.
- **Any entry where you recorded disagreeing with the user.** Ask whether that
  disagreement should stay in the promoted entry. Recommend that it does.
- **Any empty or hand-wavy "What would change our mind."**

The user answers one of three ways:

- **keep** → promote as-is (subject to step 3).
- **cut** → drop it. It does not go to `DECISIONS.md`.
- **a correction** → apply their words verbatim, then promote.

Anything ambiguous is a question, not a guess. Ask.

**Done when:** every draft has a keep / cut / correction verdict.

### 3. Promote, in the user's wording

Write kept entries into `docs/DECISIONS.md`, **newest first** — the newest
promoted entry goes at the top of the file, above everything already there.

For each promoted entry:

- **Drop the `[DRAFT]` marker.** `## [DRAFT] 2026-08-16 · Title` becomes
  `## 2026-08-16 · Title`.
- **Keep the user's wording.** Do not rewrite into your voice, do not tighten
  their prose, do not "improve" the phrasing. Their sentence, verbatim, is the
  artifact. Your only edits are the ones they dictated.
- **Keep the structure** — same six bold headings, same order.
- **Resolve `INFERRED` lines.** Confirmed: drop the marker, keep the line.
  Corrected: replace with their words, drop the marker. Neither: the line does
  not get promoted. An `INFERRED` marker must never survive into
  `docs/DECISIONS.md`.

Then remove the promoted and cut entries from `docs/DECISIONS.draft.md`,
leaving only anything not yet reviewed.

**Done when:** `DECISIONS.md` holds the kept entries newest-first with no
`[DRAFT]` and no `INFERRED` markers, and the draft file holds only unreviewed
entries.

### 4. Commit and push

```
git add docs/DECISIONS.md docs/DECISIONS.draft.md
git commit -m "docs: promote N decision entries to the log"
git push -u origin HEAD
```

Write the commit body to say what was decided, not that files moved.

If every draft was cut, still commit — the emptied draft file is a real change.
If there were no drafts at all, commit nothing.

The filesystem is ephemeral. On a network push failure, retry up to 4 times
with 2s, 4s, 8s, 16s backoff, then tell the user the promotion did not survive.

**Done when:** both files are pushed and the user is told what landed.
