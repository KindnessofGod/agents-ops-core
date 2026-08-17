# The problem — why this exists

For anyone. No technical background assumed. No code on this page. Every
abbreviation is spelled out the first time it appears.

**About the numbers on this page.** Every statement about what the software
actually does was checked against the source files on 17 August 2026. Figures
used to illustrate an argument — rather than to describe this system — are
marked **(illustration)**. Judgements rather than measurements are marked
**(estimate)**.

---

## The short version

There is one number that almost every organisation running artificial
intelligence (AI) on real work reports to its board. It is cheap to produce, it
sounds like quality, and it measures cost. The error is not random. **It runs in
the flattering direction every single time.** The worse your system behaves at
the moment a customer gives up, the better the number looks.

This library exists because nineteen applications were about to compute that
number nineteen times, each in a slightly different way, and report it upward as
though it meant something it does not mean.

---

## Two measures that are not the same measure

### Unassisted containment

*The case finished without a person being asked to decide.*

That is all it means. It counts **staff effort avoided**. It is a cost figure.
It is visible the moment the case closes, straight out of your own records, for
free.

The two-word form is deliberate and this library never shortens it. Written
short, the word reads as though a human being involved were a failure. Written
in full — *unassisted* containment — it says what it records: nobody assisted.
Whether that was good is left completely open, which is the honest position.

### Resolution

*The person whose problem it was actually got what they were entitled to.*

That is the one you care about. It measures whether the system was any good.
And it is **not knowable when the case closes.** You have to wait, and look at
evidence from outside the system: nothing came back within an agreed window;
somebody re-checked a sample; or money went back out — a refund, a reversal, a
clawback.

Two figures. Two different meanings. Two different moments in time. Two
different costs to produce.

### You will meet the first one under three other names

A vendor, a consultant or an internal deck will call the same cost figure by a
friendlier name. All three mean "no person was involved", and all three carry
the identical trap:

- **Straight-through processing** — the older banking term. Same number.
- **Automation rate** — sounds like progress. Measures cost.
- **Deflection rate** — the call-centre term, and the least honest of the three.
  "Deflection" describes pushing people away, which is precisely what nobody
  wants to be measuring.

When any of the three is presented as evidence of quality, there are two
questions to ask: *measured against what standard?* and *observed how long after
the case closed?* A figure produced at the moment of closing cannot be an answer
about quality, whatever it is called.

---

## Why they get merged, and why the merge always flatters

The mechanism is not wickedness. It is arithmetic and budget.

- Unassisted containment costs approximately nothing. It falls out of your own
  records automatically, immediately.
- Resolution costs real money. It needs somebody to define what the right answer
  is, an outside source of evidence, and a waiting period before you can look.

So the cheap number gets measured, the expensive name gets attached to it, and
the result is reported. Nobody signs anything dishonest. The wrong number just
quietly wears the right name.

Now watch which way the error runs. **A customer who gives up in frustration
halfway through is contained.** Nobody escalated. The case closed. The number
improved. They were not resolved — they were defeated. The ruder, slower and
more confusing your system is at that moment, the more people give up, and the
better the number gets.

That is the whole argument in one sentence: *the number improves when the system
fails in the most damaging way available to it.*

---

## The four things that can actually happen

Every case lands in exactly one of four boxes. All four occur in real
operations.

|  | **Resolved** — they got what they were owed | **Not resolved** |
|---|---|---|
| **Contained** — no person was asked to decide | The intended path — **provided the decision was not one a person must make by law.** If it was, this box is a breach, not a success | **The dangerous box.** Gave up; wrong and nobody argued; ran out of time unnoticed; a decision that should have gone to a person and never did. **Looks identical to your best cases** |
| **Not contained** — a person decided | The safety net working exactly as designed. It is also **the only correct box for a decision a person must make by law.** Costs a salary. The usual number scores this as a **failure** | The most expensive box of all. You spent a person's time and it was still wrong |

Two of these four boxes are the reason this document exists.

---

## The bottom-left box: a correct escalation is scored as a failure

Bottom-left. A case the system was right to hand to a person, which the person
then handled correctly. The customer got what they were owed. Everything worked.

The unassisted-containment number records that as a miss.

Now make that number a target. You have just told a team, in the only language
an organisation actually speaks, that **handing hard cases to people is what
they are being marked down for.** They do not need to be dishonest to respond.
They will lower a confidence threshold here, widen an automatic path there,
retire a rule that "fires too often" — each change defensible on its own, each
one lifting cases out of the bottom-left box and into the contained row above.
Some of those cases land top-left, which is fine. The ones that genuinely needed
a person land **top-right**, which is the dangerous box, and they look exactly
like the ones that landed top-left.

This is not a hypothetical incentive. It is the arithmetic consequence of
shipping one number, and it is why this library **records unassisted containment
and sets no target on it anywhere.** There is no target figure in the library, no
default and no configurable goal. The library records it; each application may
set its own target, in its own code, next to its own list of decisions a person
must make by law — where the two can be read together, which is the only place
either makes sense.

---

## The top-right box: "nobody was involved" includes "nobody decided at all"

Top-right, and this is the one that makes the whole number untrustworthy.

"No person was involved" is silently true of three completely different things:

1. The system judged the case correctly and closed it.
2. The case ran out of time and fell to a default.
3. The customer abandoned it.

All three are unassisted. Only the first involved any judgment at all. Reported
as one figure, a system that thinks and a system that has quietly stopped
thinking produce **the same number**.

Worse, the failure is invisible in the ordinary sense. Nothing throws an error.
No request fails. No dashboard turns red. A decision that a person was legally
required to make, and which the machine made instead, **returns success** — a
legal breach reported as a good outcome.

This is why the library raises the alarm on things that did **not** happen, not
only on things that failed. It names **9 alert conditions, and not one of the 9
can be found by catching an error.** Eight of them return success or return
nothing at all: a decision a person must make finished with nobody involved; an
action was attempted and its outcome was never recorded; the reminders stopped
firing; a case has exhausted its chasing plan and is still unanswered; there is
nobody to escalate to; decisions were recorded with no evidence of the work
behind them; the record was unavailable on a high-risk case; a rate moved
sharply. The 9th is an absence of a different kind, and it outranks all of them:
the chaser stopped proving it was still running.

There are 4 severity bands. **5 of the 9 conditions sit in the highest band
available to a single case** — a guarantee has already failed for a named case,
somebody should be woken. The 9th sits in a band of its own, above all of them,
and that ranking is proved by the compiler rather than written in a comment.
One stalled case is one customer. A stopped chaser is every waiting case at
once.

---

## The case that settles the argument

There is a class of decision a person must make, by law or standing policy —
refusing a claim, denying credit, anything the affected person has a legal right
to appeal. For those, the **correct unassisted-containment value is exactly
zero.** Not low. Nil. Any non-zero value is a breach.

That is what proves the number is not a scoreboard. A figure whose target is *as
high as possible* for some case types and *exactly nought* for others is
obviously not a score. It is a reading, like a temperature. You do not want your
temperature to be high. You want to know what it is.

So in this library, that status cannot be switched off by editing a setting. It
is enforced by the shape of the software: a decision recorded as one a person
must make has **no time-limit branch at all** — the branch is deleted from its
type, so writing one is a build failure rather than a policy somebody is trusted
to follow. There is no override, no threshold and no confidence figure that
bypasses it. "The model was 99.8% certain" (illustration) is not an argument,
because the obligation never depended on the system's opinion of itself.

---

## What the software actually does about all this

Checked against the source on 17 August 2026. Seven mechanisms, and none of them
is a guideline:

1. **Unassisted containment is compulsory at close.** Closing a case requires
   that one true-or-false field. It cannot be omitted and there is no
   general-purpose "success" field to hide it in.
2. **There is no resolution field anywhere in the library.** Not empty — absent,
   across all 50,417 lines of source. Resolution needs a named outside evidence
   source and a waiting period, neither of which the library may invent on
   nineteen applications' behalf. The library refuses to record a figure it
   cannot stand behind rather than let each team make one up.
3. **"Nobody decided" is its own ending.** A decision has 6 possible endings,
   and "ran out of time with nobody answering" is a separate one from "a person
   refused". They are different facts. Collapsing them is exactly how the
   dangerous box fills up unnoticed.
4. **Waiting is not an ending.** A case sitting with an approver is not among
   the 6, so no report can count it as finished in either direction.
5. **The chasing never stops.** A decision needing a person cannot be declared
   without a chasing plan. The plan has no "stop" value and no maximum number of
   attempts — the software cannot express giving up. The shipped settings put a
   floor of 1 hour between reminders and a ceiling of 12 recipients on each one,
   and a plan declaring a tighter cadence than the floor is refused by name.
   Reminders widen the audience each cycle instead of getting louder, because a
   flooded channel gets muted and a muted channel makes the case *less* likely
   to be answered than silence would.
6. **Rubber-stamping is measured, not asserted.** Time taken is recorded on
   every approval, measured from the moment the request was actually put in
   front of somebody — and recorded as "not measurable" rather than as an
   invented number when that moment is unknown. A queue averaging 1.2 seconds
   per approval (illustration) is visible in the data without anybody having to
   accuse a colleague. The library records the signal and sets no threshold: a
   £200 expense and a £2 million payment do not share a believable reading time.
7. **Agreement is never reported as accuracy.** When the system is measured
   against what humans actually did, the result is a different kind of report
   from the one produced by measuring against known-correct cases — and the two
   are not interchangeable in the software. Passing the wrong one to the quality
   gate does not compile. If your reviewers are wrong 8% of the time
   (illustration), a system agreeing with them perfectly is also wrong 8% of the
   time, and one that disagrees on exactly those cases scores 92% while being
   right.

---

## What it deliberately does not do

- **It sets no target on unassisted containment.** Recorded, never optimised.
- **It will not compute resolution for you, and today it records none at all.**
  Three evidence shapes are named in the binding vocabulary — nothing came back,
  somebody re-checked, money went back — and each application must choose one,
  name it, and state the window before any resolution figure can be recorded
  anywhere. The library holds the line by having no such field, which is the
  strongest form of refusal available. The one place the same discipline **is**
  built is the dress rehearsal: comparing the system against what people
  actually did requires a named source of those human decisions and a named
  observation window, both compulsory, and cases with no human decision inside
  the window are dropped and counted rather than quietly scored against nothing.
- **It ships no list of decisions a person must make by law.** It cannot know
  your statutes, and a guessed list is quietly wrong — which is the failure mode
  this entire document is about. What it does enforce is that the question gets
  asked on every case and answered in the record either way. A decision point
  that hands over nothing to screen is refused by name, because "we checked and
  it is not reserved" and "nobody thought about it" must never be the same row
  in an archive somebody reads in 2033.

---

## Where the wording and the software differ

Two, both checked on 17 August 2026, both stated because a documentation set
that hides its own gaps is the same failure at one remove:

1. **The short form of the word is banned by rule, not by a tool.** The project's
   own instructions say the shortened form of "unassisted containment" is a
   build failure. In practice **0 bare uses exist** in the source, so the rule
   holds — but it is held by review, not by any automated check. The automated
   check that does run enforces something else: which parts of the software may
   reach into which.
2. **One half of one alarm is not built.** The rule as written watches two
   rates: the share of safety screenings that failed safe, and the share of
   cases where the system declined to judge. **Only the first of the two is
   produced by any code.** Nothing watches the second. An abstention that ends
   in an automatic default with no person involved is contained, is very
   unlikely to be resolved, and is meant to have its own alarm. Today it does
   not.

Both belong in the "what isn't finished" list rather than in a paragraph that
implies otherwise.
