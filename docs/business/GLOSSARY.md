# Glossary — every term, in plain words

For anyone. No prior knowledge assumed. No code. Every abbreviation spelled out
the first time it appears.

Two halves:

- **Part 1** — words this project uses, with fixed meanings.
- **Part 2** — words you will hear from vendors, consultants and auditors,
  including the ones used loosely or misleadingly.

If a word appears in both, Part 1 is what it means here.

---

# Part 1 — Words this project uses

## The work itself

**Case**
One piece of work to be judged. One insurance claim. One invoice. One support
ticket. One expense report. Whatever your business handles, one of those is a
case.

**Decision**
One moment of judgment about a case. Most cases involve several: *is this
document readable?* is one decision, *is this claim valid?* is another, *should
we pay it?* is a third. Each is recorded separately.

**Verdict**
What a decision concluded. The decision is the event — who judged, when, using
what. The verdict is the answer itself. Rather like the difference between a
court hearing and the sentence handed down.

**Effect**
Something that actually happens in the real world because of a verdict. Money
leaves an account. An email is sent. A policy is cancelled. Effects are the only
part you cannot take back, which is why almost every safety rule in this project
is about them.

**Trace**
The complete written record of everything that happened on one case, in order,
which cannot be edited afterwards. Written to be read years later by somebody
hostile — an auditor, a regulator, a lawyer.

**Correlation identifier**
The reference number that ties every part of one case together, so all the
pieces can be found later. Like a hospital patient number.

## What the computer can conclude

**Confidence**
How sure the computer is that its own answer is right. A guess about its own
reliability, and not to be confused with the answer being important.

**Abstention**
The computer deliberately saying "I am not going to answer this one." Not a
crash and not an error — a working system reporting that it cannot judge this
case, because information is missing, the question is outside what it handles,
or a safety check fired.

This is a **good** outcome, not a bad one. A system that never abstains is
guessing on the cases it should have declined.

## Who decides, and who is allowed to act

**Escalation**
Handing a case to a named person, so that **they** decide instead of the
computer. Note the word *decide*. Sending someone a notification is not
escalation. Asking a bigger, more expensive computer is not escalation either —
that is just a second attempt. Escalation means authority moved to a human.

**Approval**
A named person or policy saying "yes, you may actually do this." It answers a
different question from a verdict. The verdict says *this invoice looks
legitimate*. The approval says *you may pay it*. Keeping those separate is what
lets you re-run a case to check it without accidentally paying twice.

**Dual control**
Two different people must both approve before something happens, and the system
makes it impossible for one person to be both. Common wherever large sums move.

**Kill switch**
A single control that stops the system doing anything in the real world, without
stopping it from thinking. During an incident you switch it on: payments stop,
but the system keeps recording what it *would* have done — which is exactly what
you need afterwards to work out what went wrong.

**Reserved decision**
A decision a person must make, by law or by company policy, and the computer is
not allowed to make it however sure it is.

Refusing someone's claim, denying credit, anything the affected person has a
legal right to appeal — these are commonly reserved. The important part: "the
computer was 99.8% certain" is **not** a reason to skip it. The obligation has
nothing to do with how confident anything is.

## How risky a decision is

**Risk tier**
A label — low, medium, high — describing **how bad it would be if this went
wrong**. Assigned before the work starts. It decides which safeguards apply,
which computer does the work, and whether a person must sign off.

The most common mistake is to confuse this with confidence. They are different
questions:

- **Confidence** — how likely are we to be wrong?
- **Risk tier** — how much would it cost us to be wrong?

You can be extremely confident about something extremely dangerous. Multiplying
the two together into a single score destroys your ability to say "we are
almost certain, and it still needs two signatures, because it is £2 million."

Reserved decisions are a third, separate thing again: a £50 decision can be
reserved by law while a £2 million one is not.

## Whether it worked

These two are the most commonly confused pair in this whole industry, and the
confusion always flatters whoever is reporting.

**Unassisted containment**
The case finished without a person being asked to decide.

That is all it means. It counts **money saved on staff**, and nothing else. It
is not a quality score, and human involvement is not failure — it is expense.

Two warnings, and both matter:

- "No person was involved" quietly includes "**nobody decided at all**" — a case
  that timed out, hit a default, or was abandoned by a frustrated customer.
  Those look identical to cases handled well.
- For a **reserved decision**, the correct value is **zero**. Not low. Zero. A
  computer handling one is a breach, not efficiency.

A number whose target is "as high as possible" for some cases and "must be
exactly nil" for others is not a scoreboard. It is a reading, like a
temperature.

**Resolution**
The person whose problem it was actually got what they were entitled to.

This is the one you actually care about, and it is expensive, because **you
cannot know it when the case closes**. You have to wait and look outside the
system.

**Resolution evidence**
The outside signal that tells you whether it was resolved, and how long you wait
before looking. One of three:

- **Quiet** — nothing came back. No reopen, no complaint, no appeal, within an
  agreed period. Cheapest. Weakest: silence is not agreement, and somebody who
  gave up in disgust is also silent.
- **Reviewed** — a person re-checked a random sample of finished cases and said
  whether they were right. The only one that catches quiet wrongness. Costs
  staff time on cases nobody complained about, which is why it is the first
  thing cut when budgets tighten.
- **Reversed** — money went back: a clawback, a reversal, a refund. The hardest
  evidence there is, and finance already records it. Only exists where money
  moves, so it suits invoices and claims better than ticket sorting.

### The four things that can happen

|  | **Resolved** — they got what they needed | **Not resolved** |
|---|---|---|
| **No person involved** | What you were aiming for — *unless the decision was reserved, in which case this is a breach.* | **The dangerous one.** Gave up; wrong but nobody argued; timed out unnoticed. Looks exactly like your best cases. |
| **A person was involved** | The safety net working perfectly. Costs a salary. Containment scores this as a **failure**. | Worst of all: you spent a person and it was still wrong. |

The bottom-left cell is why containment must never be a target on its own. Pay a
team to raise it and you have paid them to stop handing hard cases to people.

## Checking quality

**Golden case**
A case where somebody has decided, deliberately and in advance, what the correct
answer is — then written it down and frozen it. You run the system against these
to check a change hasn't broken anything.

Their strength is that they never change, so if the score moves, the *system*
changed. Their weakness is the same thing: real life moves on and they don't.
Passing them proves you haven't gone backwards. It does not prove you are
handling today's work well.

**Shadow run**
Letting the system judge real, live cases while **making absolutely sure its
answers do nothing at all** — then comparing what it decided against what the
human actually did. A dress rehearsal on the real building, with the doors
locked.

**Agreement**
How often the system's answer matched the human's answer in a shadow run.

**Agreement is not accuracy, and this trips up almost everybody.** The humans
are the yardstick — including every mistake they make. If your reviewers are
wrong 8% of the time, a system that agrees with them perfectly is *also* wrong
8% of the time. And a system that disagrees on exactly those cases scores 92%
while being completely right.

Never let "97% agreement" be written or spoken as "97% accurate". Every
disagreement is a case for somebody to look at, not a fault.

---

# Part 2 — Words you'll hear from other people

Vendors, consultants and auditors use these. Some are fine. Some are the same
idea under a friendlier name. Where one is misleading, it says so.

## About the technology

**Artificial intelligence (AI)**
Software that produces judgments rather than following a fixed set of written
rules. Deliberately vague; it covers a huge range of things.

**Large language model (LLM)**
The kind of system behind tools like Claude and ChatGPT. It reads text and
writes text. It predicts what should come next, extremely well. Two consequences
worth holding on to: it is **not** looking anything up unless you give it the
documents, and it can be confidently wrong.

**Model**
Shorthand for the piece that does the judging. "Which model are we using" means
"which one of these, and how much does it cost per use."

**Prompt**
The instructions given to the model. Changing the wording changes the answers,
which is why prompts are version-controlled like code here.

**Token**
The unit these systems are billed in — roughly three-quarters of a word. "10,000
tokens" is about 7,500 words. You pay per token, in and out.

**Retrieval-augmented generation (RAG)**
Fetching your own documents first, then handing them to the model with the
question, so the answer is based on your material rather than the model's
memory. Standard practice; less exotic than it sounds.

**Application programming interface (API)**
The agreed way one piece of software talks to another. When someone says
"through the API" they mean "programs talk to it directly, no person clicking."

**Model Context Protocol (MCP)**
A published standard for letting a model use outside tools — look something up,
send something, fetch a file. Useful when you want an outside system to reach
your tools. Most internal systems don't need it.

**Workflow** and **agent**
Two ways of arranging this software, and worth knowing apart:

- A **workflow** follows steps you wrote down in advance. Predictable. Testable.
- An **agent** decides its own next step as it goes. Flexible, more expensive,
  much harder to audit — and small errors compound.

This project is built for workflows. That is a deliberate choice, written up in
full in `docs/adr/0001-workflows-not-agents.md`, along with the specific things
that would make us change our minds.

**Hallucination**
The model stating something false with complete confidence. Not lying — it has
no concept of truth, it is producing plausible text. This is why the groundedness
check exists.

**Groundedness**
Checking that what the system said is actually supported by the documents it was
given, rather than invented.

**Guardrails**
The safety checks around the model: removing personal data, spotting attempts to
manipulate it, checking the answer is grounded.

**Prompt injection**
Somebody hiding instructions inside a document your system reads, hoping the
system obeys them instead of you. A real attack, not a theoretical one.

**Personally identifiable information (PII)**
Information that identifies a specific person — name, address, account number,
national insurance or social security number. Handling it wrongly is a
reportable incident, not a bug.

## About measuring

**Straight-through processing (STP)**
The older, banking-industry name for unassisted containment. Same number, same
trap.

**Deflection rate**
A call-centre term for the share of contacts that never reached a person.
Containment again, with the least honest name of the three — "deflection"
describes pushing people away, which is exactly what nobody wants to be
measuring.

**Automation rate**
Containment again. Sounds like progress. Measures cost.

**Human-in-the-loop**
A person is involved somewhere. Vague on purpose: it does not say whether the
person **decides**, merely **reviews**, or just **gets told afterwards**. Those
are three very different things, and only the first is escalation. Ask which one
is meant, every time.

**False positive** and **false negative**
The two ways of being wrong. A false positive flags something that was fine. A
false negative misses something that wasn't. They almost never cost the same,
and which one you'd rather have is a business decision, not a technical one.

**Precision** and **recall**
- **Precision** — of everything we flagged, how much deserved it? (Are we crying
  wolf?)
- **Recall** — of everything that deserved flagging, how much did we catch? (Are
  we missing things?)

Pushing one up usually pushes the other down.

**Accuracy**
How often the answer was right. Fine as a word, but demand to know **against
what**. Against golden cases it means one thing; against what humans happened to
do it means something much weaker — see **agreement** in Part 1.

**Benchmark**
A standard test set used to compare systems. Useful for narrowing a shortlist.
Nearly useless for predicting how something performs on *your* work, because
your cases are not in it.

**Evaluation ("evals")**
Running the system against known cases and scoring it. This is the honest
version of the above, because the cases are yours.

**Model as judge / LLM as judge**
Using one model to mark another's answers. Practical at scale, since human
marking is slow and expensive. Treat one judgment as an opinion, not a
measurement — ask several times and look at the spread.

**Service level agreement (SLA)**
A promise about speed or availability. Note it usually says nothing about
whether answers are *correct*.

**Drift**
The world changing underneath a system that hasn't changed. New fraud patterns,
new document formats, new products. Accuracy falls without anything breaking,
which is what makes it dangerous.

**Audit trail**
The record of what happened, kept for regulators. Called a **trace** here.

**Regression**
Something that used to work and now doesn't, usually caused by a change intended
to improve something else. The reason golden cases are run on every change.

---

## Anything missing?

If you hit a word in a meeting that isn't here, it belongs here. Add it or ask
for it — a glossary that people stop trusting because it's incomplete is worse
than no glossary, because they stop looking things up and start guessing.
