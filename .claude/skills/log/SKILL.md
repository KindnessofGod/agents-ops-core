---
name: log
description: Capture the decision we just made as a builder's-log draft. Use when the user types /log, or says "log that", "record this decision", "write that down". Asks at most two questions, drafts one entry into docs/DECISIONS.draft.md, and shows it before committing.
disable-model-invocation: true
---

# /log — capture the decision we just made

One decision, one entry, right after it happens — while the reasoning is still
in the room. This is not a summary of the session; the `SessionEnd` hook does
that. This is the single fork the user just resolved.

## Steps

### 1. Find the decision

Scan back through the conversation for the most recent point where a fork with
a real trade-off was resolved. If several are candidates, pick the one closest
to the user's last message and name it in your first question so they can
redirect you.

If you genuinely cannot find a decision — the recent conversation was
mechanical — say so in one sentence and stop. Do not write an entry. Do not
ask questions to manufacture one.

**Done when:** you can state the decision in one sentence.

### 2. Ask at most two questions

Two is the ceiling, not the target. Ask zero if the transcript already answers
everything. Spend the questions on what you cannot recover from the transcript,
which is almost always one of:

- **The real reason.** You have what they chose; you often don't have why.
- **The trigger to revisit.** What would make them change their mind.

Do not ask them to confirm what they already said. Do not ask them to pick a
tag — infer it, they will correct you when they see the draft.

**Done when:** the questions are answered, or you decided to ask none.

### 3. Draft the entry

Append to `docs/DECISIONS.draft.md`, newest at the bottom. Never write to
`docs/DECISIONS.md` — promotion happens only through `/log-review`.

```
## [DRAFT] YYYY-MM-DD · <title>
**Tag:** [DECISION|REJECTED|CORRECTION|LEARNED]
**The question.**
**What I proposed.**
**What the user decided.**
**Why (their words where you have them).**
**What would change our mind.**
```

Tags:

- `DECISION` — a fork resolved, a path chosen.
- `REJECTED` — an option considered and turned down. Record these; the
  discarded options are most of the value of a decision log.
- `CORRECTION` — something previously believed or written turned out wrong.
- `LEARNED` — a fact about the domain, the tools, or the environment that was
  not obvious and cost something to find out.

Binding rules:

1. **Quote the user.** Their words in quotation marks under
   "Why". A paraphrase in your voice loses the thing worth keeping.
2. **Mark inferences `INFERRED`.** If you are reconstructing a rationale rather
   than reporting one, prefix that line with `INFERRED` so it can be corrected
   on review. Never invent reasoning the user did not give.
3. **If the user overruled you, say so plainly.** Name what you proposed, name
   what they chose, and if you still think you were right, say where you think
   they are wrong and why, in one or two sentences. Do not soften it and do not
   omit it. An entry that records only agreement is not worth the disk.
4. **"What would change our mind" must be concrete** — a measurement, a failure
   mode, a scale threshold. Not "if requirements change".

**Done when:** the entry is appended and matches the format exactly.

### 4. Show it, then commit

Print the entry back to the user in full. Ask nothing further — they will
correct it if it is wrong.

Then:

```
git add docs/DECISIONS.draft.md
git commit -m "docs: log <short title>"
git push -u origin HEAD
```

The filesystem is ephemeral. An uncommitted draft does not exist. If the push
fails for a network reason, retry up to 4 times with 2s, 4s, 8s, 16s backoff,
then tell the user it did not survive.

**Done when:** the entry is shown and pushed.
