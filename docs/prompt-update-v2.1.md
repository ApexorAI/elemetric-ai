# Prompt Update v2.1 — AS/NZS 3500.1:2025 Cold Water Services

**Date:** 2026-03-22
**Prompt Registry Version:** `plumbing` → `2.1.0` | `coldWater` → `2.1.0` (new)
**Standard:** AS/NZS 3500.1:2025
**Jurisdiction:** Victoria, Australia — Building and Plumbing Commission (BPC)

---

## Summary

A comprehensive new trade type prompt has been added for cold water services under AS/NZS 3500.1:2025. The prompt covers 11 sections with clause-referenced checklist items, 20 compliant (PASSING) and 20 non-compliant (FAILING) few-shot examples, and full photo guidance. Routing is via `type: "cold_water"` or `type: "cold_water_services"`.

The `VICTORIAN_REGULATIONS.plumbing.coldWaterServices` sub-object has been added with 24 specific regulatory references covering every major compliance area.

The `PROMPT_REGISTRY.plumbing` version has been bumped from `2.0.0` to `2.1.0`. A new `PROMPT_REGISTRY.coldWater` entry at `2.1.0` has been added.

---

## Victorian Regulatory Context

AS/NZS 3500.1:2025 is adopted under the National Construction Code Volume Three Plumbing Code of Australia, given effect in Victoria through the Building Act 1993 and Plumbing Regulations 2018. Compliance is enforced by the Building and Plumbing Commission (formerly VBA). Licensed plumbers must hold a current licence and issue a Certificate of Compliance for all regulated work. The BPC conducts random inspections and audits. Non-compliant work can result in licence suspension, rectification orders, and civil liability exposure.

---

## Active Checklist Items (49 total across 11 sections)

### Section 1 — Cross-Connection Prevention (Appendix E.2) — 4 items

| # | Item | Clause |
|---|------|--------|
| 1 | Hose tap outlet above flood level rim | Appendix E.2(c) |
| 2 | Garden hose outlet above pool or pond surface | Appendix E.2(c) |
| 3 | Backflow prevention on haemodialysis machine or bidet | Appendix E.2(c) |
| 4 | Water supply outlet above liquid surface in process tank | Appendix E.2(e)(i) |

### Section 2 — Storage Tank Disinfection (Appendix G) — 4 items

| # | Item | Clause |
|---|------|--------|
| 5 | Tank interior clean before disinfection | Appendix G.1 and G.2 |
| 6 | Tank disinfection chlorine residual 10 mg/L | Appendix G.3(a) |
| 7 | Tank surface application disinfection contact time | Appendix G.3(b) |
| 8 | Post-disinfection flush and final chlorine test | Appendix G.3 |

### Section 3 — Water Service Disinfection (Appendix H) — 4 items

| # | Item | Clause |
|---|------|--------|
| 9 | Water service flushed clear before chlorination | Appendix H.3 |
| 10 | Water service chlorination residual 10 mg/L after 6-hour hold | Appendix H.4(a) |
| 11 | DN 80 or larger main disinfected to required procedure | Appendix H.4(b) |
| 12 | Final flush — chlorine residual normalised at outlet | Appendix H.5 |

### Section 4 — Pipe Installation (cl 5.x) — 17 items

| # | Item | Clause |
|---|------|--------|
| 13 | Copper pipe AS 4809 compliance marking | cl 5.2.1 |
| 14 | PVC pipe AS/NZS 2032 marking and installation | cl 5.2.2.1 |
| 15 | Above-ground water pipe 25mm separation from other services | cl 5.3.2 |
| 16 | Underground water pipe separation from electrical cable | cl 5.3.3.1(a) |
| 17 | Underground water pipe separation from gas pipe | cl 5.3.3.2 |
| 18 | Water service on shelf 100mm above drain in shared trench | cl 5.3.3.4 |
| 19 | Underground service crossing at 45 degrees minimum with marker tape | cl 5.3.4 |
| 20 | Isolating valve at required location | cl 5.4.2 |
| 21 | Pipe through timber stud with grommet or sealant | cl 5.5.2.1(a) |
| 22 | Pipe through metal stud with protective grommet | cl 5.5.2.1(c) |
| 23 | Under-slab pipe sand bedded with 75mm clearance and capped | cl 5.5.4 |
| 24 | Pipe cut end free of burr before jointing | cl 5.6.1(a) |
| 25 | Silver brazing on tap or valve DN 20 or smaller | cl 5.6.8.2 |
| 26 | Above-ground pipe support spacing within Table 5.7.4 limits | cl 5.7.4 |
| 27 | Buried water pipe minimum cover depth | cl 5.10 |
| 28 | Buried pipe 75mm compacted sand bedding and clean backfill | cl 5.11 |
| 29 | Water service in contaminated area in sealed conduit or elevated 600mm | cl 5.12 |
| 30 | Metallic pipe in corrosive soil with impermeable external protection | cl 5.13 |
| 31 | Exterior pipe frost protection insulation or burial depth | cl 5.18.2 |
| 32 | Water service pipe identification markings in Class 2–9 buildings | cl 5.19 |

### Section 5 — Storage Tanks (cl 8.x) — 5 items

| # | Item | Clause |
|---|------|--------|
| 33 | Storage tank on rated base with non-corrosive insulating membrane | cl 8.3.1 |
| 34 | Storage tank close-fitting secured cover and 0.5m2 access opening | cl 8.4.3 |
| 35 | Tank overflow pipe DN 40 minimum discharging to visible location | cl 8.4.4.1 |
| 36 | Safe tray minimum 50mm sides, DN 50 drain, tank 75mm inside tray edge | cl 8.8.1 |
| 37 | Tank identification notice 450mm x 250mm red background white text | cl 8.9 |

### Section 6 — Non-Drinking Water Services (cl 9.x) — 5 items

| # | Item | Clause |
|---|------|--------|
| 38 | Non-drinking water meter permanently purple coloured and accessible | cl 9.2.2 |
| 39 | Non-drinking pipe 25mm separation from drinking water pipe | cl 9.3.2.1 |
| 40 | No physical connection between drinking and non-drinking systems | cl 9.4 |
| 41 | Non-drinking water pipework purple throughout or fully sleeved | cl 9.6.1 |
| 42 | Purple marking tape on buried non-drinking water pipe | cl 9.6.3 |

### Section 7 — Irrigation and Greywater (cl 7.x, cl 10.x) — 2 items

| # | Item | Clause |
|---|------|--------|
| 43 | Irrigation system backflow prevention matched to system type | cl 7.2 and cl 7.3 |
| 44 | Backflow prevention on drinking water supply to greywater system | cl 10.3 |

### Section 8 — Flush Valves and Cisterns (cl 11.x) — 2 items

| # | Item | Clause |
|---|------|--------|
| 45 | Flush valve operating mechanism at or below 2m above floor | cl 11.4 |
| 46 | Flush valve outlet minimum 450mm above pan or urinal rim | cl 11.9.5 |

### Section 9 — Pumps and Water Meters (cl 12.x, cl 14.x) — 2 items

| # | Item | Clause |
|---|------|--------|
| 47 | Pump with vibration eliminators, isolation valves, non-return valve, pressure gauges | cl 12.4 |
| 48 | Water meter horizontal, accessible, upstream isolation valve present | cl 14.2 |

### Section 10 — Rainwater Tanks (cl 15.x, cl 16.x) — 4 items

| # | Item | Clause |
|---|------|--------|
| 49 | Rainwater pipe marked RAINWATER at required intervals | cl 15.3.2.1 |
| 50 | Backflow prevention between rainwater system and drinking water supply | cl 15.3.3 |
| 51 | Rainwater tank on rated base with no load transferred to pipes | cl 16.2.1.1 |
| 52 | Rainwater tank internal green RAINWATER notice 450mm x 250mm | cl 16.5.1 |
| 53 | Rainwater tank overflow DN 90 minimum and equal to or larger than inlet | cl 16.3.2 |

### Section 11 — Testing and Commissioning (cl 18.x, Appendix B.2) — 4 items

| # | Item | Clause |
|---|------|--------|
| 54 | Hydrostatic pressure test 1500 kPa for 30 minutes on exposed pipe | cl 18.2 and cl 18.3.1 |
| 55 | Storage tank continuous overflow for 1 minute with confirmed air gap | cl 18.3.2 and cl 18.4 |
| 56 | All valves, taps, cisterns, and relief valves operated and confirmed functioning | cl 18.6 |
| 57 | WaterMark licence number visible on all plumbing products | Appendix B.2 |

**Total active items: 57** (across 11 sections, all clause-referenced to AS/NZS 3500.1:2025)

---

## Few-Shot Calibration Examples

The prompt includes **20 PASSING** and **20 FAILING** examples, all specific to AS/NZS 3500.1:2025 cold water services items. Examples reference specific clauses including cl 5.2.1, cl 5.3.2, cl 5.3.3.1(a), cl 5.3.3.2, cl 5.3.4, cl 5.4.2, cl 5.5.2.1(c), cl 5.7.4, cl 5.10, cl 5.11, cl 5.12, cl 5.13, cl 7.2, cl 7.3, cl 8.3.1, cl 8.4.3, cl 8.8.1, cl 8.9, cl 9.3.2.1, cl 9.4, cl 9.6.1, cl 9.6.3, cl 14.2, cl 15.3.2.1, cl 15.3.3, Appendix E.2(c), Appendix H.4(a).

---

## VICTORIAN_REGULATIONS Updates

`VICTORIAN_REGULATIONS.plumbing.coldWaterServices` added with 24 specific references:

- Cross-connection at hose taps (Appendix E.2(c))
- Cross-connection at pool and pond connections (Appendix E.2(c))
- High-risk cross-connections — bidet and haemodialysis (Appendix E.2(c))
- Industrial tank submerged inlets (Appendix E.2(e)(i))
- Tank pre-cleaning before disinfection (Appendix G.1 and G.2)
- Chlorine concentration and contact time (Appendix G.3(a))
- Water service flush velocity (Appendix H.3)
- Water service chlorination residual (Appendix H.4(a))
- Large mains disinfection (Appendix H.4(b))
- Pipe compliance markings (cl 5.2.1 and cl 5.2.2.1)
- Above-ground service separation (cl 5.3.2)
- Underground separation from electrical (cl 5.3.3.1(a))
- Underground separation from gas (cl 5.3.3.2)
- Shared trench with drain (cl 5.3.3.4)
- Underground crossings (cl 5.3.4)
- Isolating valves at required locations (cl 5.4.2)
- Pipe support spacing (cl 5.7.4)
- Buried cover depths (cl 5.10)
- Tank safe tray requirements (cl 8.8.1)
- Tank overflow (cl 8.4.4.1)
- Non-drinking water colour (cl 9.6.1)
- Non-drinking water separation (cl 9.3.2.1)
- Hydrostatic test (cl 18.2 and cl 18.3.1)
- WaterMark certification (Appendix B.2)

---

## Prompt Registry

| Field | Value |
|-------|-------|
| plumbing version | 2.1.0 |
| coldWater version | 2.1.0 (new) |
| updatedAt | 2026-03-22 |
| model | gpt-4.1-mini |
| standard | AS/NZS 3500.1:2025 |
| calibration set | 20 passing + 20 failing (focused on cold water services) |

---

## Routing

Cold water services jobs route by sending `type: "cold_water"` or `type: "cold_water_services"` to `POST /review`. The `isColdWater` flag in the prompt routing logic intercepts these before the heated water services default.

---

## Syntax Verification

`node --check index.js` passed with no errors after all changes were applied.

---

*Generated: 2026-03-22*
