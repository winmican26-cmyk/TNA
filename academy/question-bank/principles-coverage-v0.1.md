# TNA Deployment Academy v0.1 — Question Bank Principles Coverage Report

Machine-derived from the actual loaded question bank (120 questions, 4 files) — regenerate by loading
`academy/question-bank/loader.js` and grouping `allQuestions()` by each question's `principles` array.
This is not hand-maintained prose; it reflects exactly what the JSON files say.

## Coverage by exact TNA-NN principle (TNA-43 through TNA-71 — verified numbering)

| Principle | Question count | Question ids |
|---|---|---|
| TNA-43 | 2 | L1-Q14, L2-Q23 |
| TNA-44 | 1 | L1-Q15 |
| TNA-45 | 0 | *(not covered — see "Known gap" below)* |
| TNA-46 | 1 | L4-Q12 |
| TNA-47 | 1 | L1-Q07 |
| TNA-48 | 3 | L1-Q11, L4-Q05, L4-Q14 |
| TNA-49 | 1 | L4-Q13 |
| TNA-50 | 1 | L4-Q09 |
| TNA-51 | 2 | L3-Q01, L3-Q02 |
| TNA-52 | 2 | L1-Q16, L3-Q17 |
| TNA-53 | 4 | L1-Q17, L2-Q28, L3-Q09, L3-Q10 |
| TNA-54 | 3 | L1-Q18, L2-Q27, L3-Q21 |
| TNA-55 | 3 | L1-Q19, L3-Q04, L3-Q05 |
| TNA-56 | 2 | L3-Q20, L4-Q29 |
| TNA-57 | 2 | L3-Q08, L3-Q24 |
| TNA-58 | 2 | L1-Q21, L2-Q21 |
| TNA-59 | 1 | L1-Q23 |
| TNA-60 | 3 | L1-Q22, L4-Q18, L4-Q19 |
| TNA-61 | 4 | L2-Q26, L2-Q29, L4-Q20, L4-Q21 |
| TNA-62 | 1 | L1-Q24 |
| TNA-63 | 1 | L1-Q20 |
| TNA-64 | 7 | L1-Q25, L2-Q09, L4-Q22, L4-Q23, L4-Q26, L4-Q27, L4-Q28 |
| TNA-65 | 8 | L1-Q04, L2-Q02, L2-Q03, L2-Q04, L2-Q05, L2-Q06, L2-Q22, L2-Q25 |
| TNA-66 | 2 | L2-Q11, L2-Q12 |
| TNA-67 | 1 | L2-Q08 |
| TNA-68 | 3 | L4-Q31, L4-Q33, L4-Q34 |
| TNA-69 | 2 | L2-Q30, L4-Q32 |
| TNA-70 | 4 | L2-Q16, L2-Q17, L2-Q18, L2-Q19 |
| TNA-71 | 3 | L2-Q13, L2-Q14, L2-Q15 |

**Known gap**: TNA-45 ("Durable State Precedes Distributed Assumption") has no dedicated question in
this v0.1 bank. Documented honestly rather than silently omitted from this report.

## Coverage by theme (TNA-01 through TNA-42 — original volumes' inline-documented principles)

Since TNA-01 through TNA-42 are documented inline within their own originating volumes rather than
collected under one numbered heading this project can cite precisely (see
`academy/principles-map-v0.1.md`), coverage for that range is reported by theme:

| Theme | Question count | Question ids |
|---|---|---|
| Authority (Gate) | 7 | L1-Q01, L1-Q02, L1-Q03, L1-Q04, L4-Q01, L4-Q02, L4-Q24 |
| Verification (VAD) | 4 | L1-Q05, L1-Q06, L4-Q07, L4-Q08 |
| Evidence (Ledger) | 5 | L1-Q07, L1-Q08, L4-Q09, L4-Q10, L4-Q11 |
| Runtime Control (Sentinel) | 7 | L1-Q09, L1-Q10, L1-Q11, L4-Q04, L4-Q05, L4-Q06, L4-Q25 |
| Assurance (Auditor) | 5 | L1-Q12, L1-Q13, L4-Q15, L4-Q16, L4-Q17 |

## Coverage by Volume 10/11-specific theme (not a numbered TNA-NN range)

| Theme | Question count |
|---|---|
| Integration (Platform) | 7 |
| Deployment | 30 |
| External Tools (MCP) | 10 |
| External Tools (Client Integration) | 10 |
| Operator CLI | 33 |
| Academy | 6 |

## Summary

- **Total questions**: 120 (25 + 30 + 30 + 35 — meets the section 2 minimums exactly)
- **Distinct principles/themes tagged**: 39
- **Not exactly one question per principle** — by design (section 5): some principles (TNA-65, TNA-64,
  Operator CLI) are covered by many questions because they are load-bearing across many scenarios;
  others (TNA-45) currently have none, honestly reported above rather than papered over.
