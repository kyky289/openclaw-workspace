---
name: "research-brain"
description: "Any research request or analysis/judgment on current info (markets, companies, macro, policy, tech, industries: examples only); thesis work. Not simple lookups."
---

# Research Brain

Operate as a research agent, not a search summarizer. Communicate the result per the AGENTS.md Response Length rules: research depth is not reply length.

## Step 0 — Scope check

Run this skill for any research request, or any question that needs analysis or a judgment based on current information. Markets, companies, macro, policy, investments, technology, and industry trends are examples, not limits. This includes:

- analysis or a judgment (why, what it means, outlook, valuation, risk, should-I, is-it-priced-in);
- cross-verification of a material, disputed, or conflicting claim;
- synthesis across several sources into a conclusion;
- creating, re-evaluating, or updating a thesis;
- Step 3 of the `thesis-monitoring` skill.

Do not run it for a simple fact or current-info lookup (a price, date, schedule, result, name, figure, definition, or latest headline), even when the topic has a thesis. Answer those directly per AGENTS.md. Escalate into this skill mid-answer if the lookup turns up conflicting sources, or the user asks what it means, for a judgment, or how it affects a thesis.

Done when: the request is research or needs analysis, a judgment, verification, synthesis, or thesis work; otherwise exit.

## Step 1 — Continuity check

1. Check `memory/thesis-*.md` for a thesis on this topic. Do not start from zero when prior research exists.
2. If one exists, read the whole file before forming any new judgment: latest thesis, key assumptions, strongest supporting and contrary evidence, invalidation conditions, monitor-next items, and the date of the last entry.
3. Treat it as a hypothesis to test, not an answer to defend. Actively search for evidence that could falsify it; do not preferentially search for evidence that confirms it.

Done when: you know whether a thesis exists and, if so, its last date and the assumptions you are testing.

## Step 2 — Research loop

1. Define the actual question and identify what evidence would answer it.
2. Search broadly enough to discover relevant information.
3. Open and inspect important sources; do not rely on search-result snippets for material claims.
4. Prefer primary sources when available:
   - company filings, earnings releases, investor relations materials
   - government agencies and official statistics
   - central banks and regulators
   - legislation and official documents
   - direct company statements
5. Cross-check important claims with independent sources when practical.
6. Separate:
   - FACT: directly supported by evidence
   - INFERENCE: conclusion derived from facts
   - JUDGMENT: current assessment after weighing evidence
   - UNKNOWN: important information that is missing or uncertain
7. Look actively for evidence against the leading thesis.
8. Form a judgment only when evidence supports one. Never manufacture certainty just to provide an opinion.
9. State what evidence would weaken, invalidate, or reverse the current judgment.
10. For important ongoing research, record the thesis (Step 4 or Step 5).

Done when: every material claim is traced to an inspected source and labeled FACT / INFERENCE / JUDGMENT / UNKNOWN.

### Source discipline

- Search is discovery, not proof.
- For material claims, use `web_fetch` or the appropriate available tool to inspect the underlying source whenever possible.
- Prefer primary evidence over commentary. Use secondary sources for context, interpretation, discovery, or when primary evidence is unavailable.
- For time-sensitive information, check dates carefully and distinguish current information from historical information.
- Never present an unverified search snippet as established fact.

## Step 3 — Analysis

Do not merely collect bullish and bearish points. Build a causal model:

- What is happening?
- Why is it happening?
- What variables are driving it?
- Which variables matter most?
- What is already priced or widely expected?
- What evidence contradicts the current explanation?
- What would change the conclusion?

Also:

- Distinguish short-term catalysts from long-term structural drivers.
- Distinguish changes in price or sentiment from changes in underlying fundamentals.
- When evidence conflicts, explain the conflict instead of hiding it.

### Judgment standard

- The goal is not to always have an opinion. The goal is to reach the best-supported current judgment.
- It is acceptable and preferred to say that evidence is insufficient when it is insufficient.
- Never invent facts, sources, causal relationships, or confidence.
- Clearly distinguish evidence from interpretation.

Done when: you can state the judgment (or "insufficient evidence"), its main causal drivers, and what would reverse it.

## Step 4 — Create a thesis (no prior thesis)

For a significant ongoing topic, save a compact thesis record to `memory/thesis-<slug>.md` (workspace-relative; `<slug>` is a short kebab-case topic id such as `nvda` or `us-crypto-regulation`) using `templates/thesis-new.md` (relative to this skill's directory). Required fields: topic, date, current thesis, strongest supporting evidence, strongest contrary evidence, key assumptions, important unknowns, confidence (low / medium / high), invalidation conditions, evidence or events to monitor.

A saved thesis is a record, not truth.

Done when: the file exists with every field filled from evidence, no placeholders.

## Step 5 — Update a thesis (Thesis Update Protocol)

A saved thesis is a versioned analytical record, not a static note.

1. Retrieve and read the existing thesis before forming a new judgment (Step 1).
2. Identify only evidence that is genuinely new since the previous thesis date.
3. Compare the new evidence directly against: the previous thesis, key assumptions, strongest supporting evidence, strongest contrary evidence, and invalidation conditions.
4. Classify the effect as STRENGTHENED, WEAKENED, UNCHANGED, or INVALIDATED.
5. Explain exactly why the classification changed or did not change.
6. Produce an updated current thesis and confidence level.
7. Update assumptions, unknowns, invalidation conditions, and monitoring items when necessary.
8. Append the update as a new dated section using `templates/thesis-update.md` (relative to this skill's directory). Never overwrite or silently rewrite previous thesis history.

Write to the file only when the new evidence materially affects the thesis, an important assumption, the confidence level, an invalidation condition, or a monitoring priority. Do not update merely because new information exists.

### Reporting the outcome (priority order)

1. **Scheduled monitoring run** (thesis-monitoring Step 3 from an automation prompt marked as a scheduled run): if there is no material change, write nothing and reply exactly `NO_REPLY`. Never report UNCHANGED from a scheduled run.
2. **User-initiated re-evaluation** (the user asked in chat, e.g. "check now" or "re-evaluate", including on a monitored thesis): always reply normally with the status, never `NO_REPLY`. UNCHANGED is a valid answer: state it, the new evidence considered, and why it is not material. Do not append to the file for UNCHANGED.
3. **Material change in either context:** append the dated section, then report the change and reasoning.

Done when: the file is appended for a material change or left untouched otherwise, and the reply follows the priority order above.

### Thesis history

- Preserve historical thesis versions.
- Never edit an old thesis merely to make a past judgment look more accurate in hindsight. If an earlier judgment was wrong, preserve it and explain in the next update what was wrong and why.
- Distinguish: new facts, changes in interpretation, changes in assumptions, and actual forecasting or reasoning errors.
- Use mistakes as research feedback. When a thesis fails, identify which assumption, evidence source, causal link, or reasoning step caused the failure.
