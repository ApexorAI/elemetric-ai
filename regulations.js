// ─────────────────────────────────────────────────────────────────────────────
// Victorian Regulations knowledge base
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the supplementary "regulations reference" the AI photo validator is
// reminded of on every /review call (see buildRegulationsNote in index.js). The
// detailed pass/fail checklists live in the per-trade prompt strings in
// index.js; THIS file is the at-a-glance clause list layered on top.
//
// ── HOW TO ADD A REGULATION (read before editing) ────────────────────────────
//   1. Find the right trade key below (plumbing / gas / electrical / drainage /
//      carpentry). Add more top-level trade keys if you start a new trade.
//   2. Add a new entry:  shortCamelCaseKey: "Plain-English rule (Standard cl X.Y)"
//        • The VALUE must be a STRING. Objects are allowed for GROUPING only
//          (e.g. plumbing.heatedWaterServices) — the flattener collects every
//          string leaf no matter how deeply nested, so grouping is safe now.
//        • ALWAYS end the string with the standard + clause in parentheses,
//          e.g. "(AS/NZS 3500.1:2025 cl 5.4.2)". The validator enforces this.
//   3. Run the validator before committing:
//          node scripts/validate-regulations.js
//      It fails on non-string leaves, missing clause references, and exact
//      duplicate rule text.
//   4. The change deploys to Railway when this repo's `main` is pushed. Review
//      the diff first — this is live, real customers, real certificates.
//
// Keep rules trade-accurate and conservative. When unsure of a clause number,
// leave the rule out rather than cite the wrong clause.
// ─────────────────────────────────────────────────────────────────────────────

const VICTORIAN_REGULATIONS = {
  plumbing: {
    ptrValveDischarge:    "PTR valve discharge pipe must terminate within 300mm of floor level (AS/NZS 3500.1:2025 cl.7.6)",
    temperingValve:       "Tempering valve must limit hot water outlet temperature to maximum 50°C (AS/NZS 3500.4:2025 cl.6.2)",
    maxSystemPressure:    "Hot water system pressure must not exceed 850kPa (AS/NZS 3500.1:2025 cl.5.3)",
    pipeSupport:          "Minimum pipe support intervals: 1.2m horizontal copper, 1.8m vertical copper (AS/NZS 3500.1:2025 cl.8.2)",
    sanitaryDrainage:     "Minimum drainage pipe gradient 1:60 for DN100 pipe (AS/NZS 3500.2:2025 cl.5.4.1)",
    stormwater:           "Stormwater drainage: minimum 1:100 gradient for box gutters (AS/NZS 3500.3:2025 cl.3.3)",
    heatedWater:          "Water heaters >50L must have approved temperature limiting device (AS/NZS 3500.4:2025 cl.5.2)",
    heatedWaterServices: {
      tpValve:              "T&P valve must be manufacturer-specified position, easing gear accessible, outlet unobstructed — no caps or plugs (AS/NZS 3500.4:2025 cl 5.8)",
      coldWaterSequence:    "Cold-water inlet: isolating valve → strainer → pressure control valve → non-return valve → expansion control valve in this exact order (AS/NZS 3500.4:2025 cl 5.9)",
      safeTray:             "Safe tray mandatory in roof space and concealed locations — minimum 50mm turn-up, DN50 safe waste with continuous fall (AS/NZS 3500.4:2025 cl 5.4)",
      tpDrainLine:          "T&P drain line: copper, same size as valve outlet, maximum 9m with ≤3 direction changes, continuous fall to external gully (AS/NZS 3500.4:2025 cl 5.11)",
      hydrostaticTest:      "Hydrostatic test 1500 kPa held for 30 minutes on bare uninsulated pipework before insulation is applied (AS/NZS 3500.4:2025 cl 9.3)",
      insulationRegionB:    "External pipe insulation minimum R0.6 in Climate Region B (NCC Zones 6, Victoria metro/regional) — UV-stabilised weatherproof jacket required (AS/NZS 3500.4:2025 cl 8.2)",
      insulationRegionC:    "External pipe insulation minimum R1.0 in Climate Region C (NCC Zones 7–8, Victorian alpine areas) (AS/NZS 3500.4:2025 cl 8.2)",
      heatTrap:             "Heat trap within 1m of hot outlet, minimum 250mm vertical drop, installed before first branch (AS/NZS 3500.4:2025 cl 8.4)",
      thermalExpansion:     "Thermal expansion provision mandatory on all heated pipe runs — offset arm, loop, or directional change with calculated free zone unclipped (AS/NZS 3500.4:2025 Appendix N)",
      expansionVessel:      "Expansion vessel pre-charge must match incoming supply pressure, documented and water-resistant label permanently affixed (AS/NZS 3500.4:2025 Appendix P)",
      circulatoryDelivery:  "Circulatory systems: delivery minimum 60°C, return minimum 55°C at commissioning (AS/NZS 3500.4:2025 cl 10.2)",
      waterMarkRequired:    "WaterMark licence number must be legible on all major components — mixing valves, tempering valves, PLVs, relief valves (AS/NZS 3500.4:2025 cl 2.2)",
      wetbackNoValves:      "Wetback primary circuit must have no valves of any kind on flow or return pipe between heat source and vessel (AS/NZS 3500.4:2025 cl 7.2)",
      solarBrackets:        "Solar collector mounting brackets must be Grade 304/316/430 stainless steel or hot-dip galvanised mild steel (AS/NZS 3500.4:2025 cl 6.3)",
      ventPipeOpenFree:     "Open vent pipe must rise continuously to atmosphere with no valves or taps in run (AS/NZS 3500.4:2025 cl 5.12)",
    },
    coldWaterServices: {
      crossConnectionHoseTap:    "Hose tap outlet must be positioned above flood level rim of any fixture — no outlet at or below rim level (AS/NZS 3500.1:2025 Appendix E.2(c))",
      crossConnectionPool:       "Garden hose outlet must not be submerged below surface of pool, pond, or fish pond while connected to potable supply (AS/NZS 3500.1:2025 Appendix E.2(c))",
      crossConnectionHighRisk:   "Bidet and haemodialysis machine connections require appropriate backflow prevention device — RPZ or equivalent installed upstream (AS/NZS 3500.1:2025 Appendix E.2(c))",
      industrialTankInlet:       "Water supply pipe outlet in process or rinse tank must discharge above maximum liquid level — no submerged inlets without backflow prevention (AS/NZS 3500.1:2025 Appendix E.2(e)(i))",
      tankPreClean:              "Drinking water storage tank must be fully drained and physically cleaned of all debris, sediment, and sludge before disinfection (AS/NZS 3500.1:2025 Appendix G.1 and G.2)",
      tankChlorineConcentration: "Fill-and-hold chlorination must achieve minimum 10 mg/L free chlorine residual at end of retention period — 6-hour minimum for gas/pump dosing, 24-hour for hypochlorite added within tank (AS/NZS 3500.1:2025 Appendix G.3(a))",
      serviceFlushVelocity:      "Water service must be flushed at minimum 0.75 m/s flow velocity at every outlet before chlorination (AS/NZS 3500.1:2025 Appendix H.3)",
      serviceChlorineResidual:   "After minimum 6-hour hold, free chlorine residual of no less than 10 mg/L must be measurable throughout entire service (AS/NZS 3500.1:2025 Appendix H.4(a))",
      largeMainsDisinfection:    "Water service DN 80 or greater must be disinfected per storage-tank procedure or ANSI/AWWA C651 — residential procedure insufficient (AS/NZS 3500.1:2025 Appendix H.4(b))",
      pipeCompliance:            "Copper pipes must carry AS 4809 compliance markings; PVC pipe systems must comply with AS/NZS 2032 (AS/NZS 3500.1:2025 cl 5.2.1 and cl 5.2.2.1)",
      aboveGroundSeparation:     "Above-ground water service pipes must maintain minimum 25mm gap from electrical, telecoms, gas, sanitary, and stormwater services (AS/NZS 3500.1:2025 cl 5.3.2)",
      undergroundElectrical:     "Underground water pipes DN 65 or less require 100mm from protected/marked electrical cable; 600mm from unprotected cable; DN over 65 requires 300mm from protected cable (AS/NZS 3500.1:2025 cl 5.3.3.1(a))",
      undergroundGas:            "Underground water pipes DN 65 or less require 100mm from marked consumer gas pipe above; 600mm from unmarked gas pipe; DN over 65 requires 300mm from marked gas pipe (AS/NZS 3500.1:2025 cl 5.3.3.2)",
      sharedTrenchDrain:         "Water service in shared trench with drain must be on shelf at least 50mm from trench continuation, 100mm horizontal gap, and pipe underside at least 100mm above drain crown (AS/NZS 3500.1:2025 cl 5.3.3.4)",
      undergroundCrossings:      "Underground water service crossings must be at angle no less than 45 degrees, minimum 100mm vertical separation, and marked with AS/NZS 2648.1 tape 1m either side at 150mm above service (AS/NZS 3500.1:2025 cl 5.3.4)",
      isolatingValves:           "Isolating valves mandatory at every required location including meter inlet, each appliance, each TMV, each PLV, each pump, each tank inlet/outlet over 50L, each irrigation offtake, and immediately before every flexible hose assembly (AS/NZS 3500.1:2025 cl 5.4.2)",
      pipeSupportSpacing:        "Above-ground copper pipe maximum clip spacings: DN 15 — 1.5m, DN 25 — 2.0m, DN 50 — 3.0m; horizontal PVC DN 15 — 0.60m, DN 25 — 0.75m, DN 50 — 1.05m (AS/NZS 3500.1:2025 cl 5.7.4 Table 5.7.4)",
      buriedCoverDepths:         "Buried water pipe minimum cover: under slab 75mm, non-traffic 300mm, sealed carriageway 600mm, unsealed carriageway 750mm, fire services non-traffic 600mm (AS/NZS 3500.1:2025 cl 5.10 Table 5.10)",
      tankSafeTray:              "Safe tray mandatory under all water storage tanks — minimum 50mm sides, watertight, DN 50 overflow drain (larger than tank overflow), continuous fall, tank minimum 75mm inside tray edge (AS/NZS 3500.1:2025 cl 8.8.1)",
      tankOverflow:              "Tank overflow pipe minimum DN 40, discharging to readily visible location within property boundary, clear of doors and windows (AS/NZS 3500.1:2025 cl 8.4.4.1)",
      nonDrinkingPurple:         "All non-drinking water pipework must be purple (Jacaranda P24 to Lilac P23) or fully sleeved or wrapped in purple — no gaps or exposed sections (AS/NZS 3500.1:2025 cl 9.6.1)",
      nonDrinkingSeparation:     "Above-ground non-drinking pipes must maintain minimum 25mm separation from any parallel drinking water pipe, or be separated by duct or structural barrier (AS/NZS 3500.1:2025 cl 9.3.2.1)",
      hydrostaticTest:           "All water service installations must be hydrostatically tested at 1500 kPa for minimum 30 minutes with no leakage — must occur before burial or concealment (AS/NZS 3500.1:2025 cl 18.2 and cl 18.3.1)",
      waterMarkRequired:         "All plumbing products must carry WaterMark certification; products contacting drinking water must also comply with AS/NZS 4020 (AS/NZS 3500.1:2025 Appendix B.2)",
    },
  },
  gas: {
    applianceClearance: "Gas appliance minimum 500mm clearance from combustible materials (AS/NZS 5601.1)",
    flueTermination:    "Flue terminal must be at least 500mm from any opening into a building (AS/NZS 5601.1)",
    testPressure:       "Gas installation leak test pressure minimum 1.5 kPa sustained for 5 minutes (AS/NZS 5601.1)",
  },
  electrical: {
    rcdTripTime:         "RCD must trip within 300 milliseconds at rated residual current (AS/NZS 3000 Clause 2.6)",
    earthConductorColour:"Earth conductors must have green/yellow striped insulation (AS/NZS 3000)",
    insulationResistance:"Minimum insulation resistance 1 MΩ between any live conductor and earth (AS/NZS 3000)",
  },
  drainage: {
    pipeGradient: "Minimum drainage pipe gradient 1:60 for 100mm pipe (AS/NZS 3500.2)",
    trapSeal:     "Minimum trap water seal depth 50mm (AS/NZS 3500.2)",
    ventStack:    "All sanitary fixtures must be vented within 3m of the trap (AS/NZS 3500.2)",
  },
  carpentry: {
    timberFraming: "Residential timber framing must comply with AS 1684 series (span tables and connection requirements)",
    deckingFixings:"Decking fixings must be corrosion-resistant — stainless steel or hot-dipped galvanised (AS 1684)",
  },
};

// Recursively collect every string-leaf rule under `node`, in declaration order.
// Objects are treated as grouping containers, so nested rule groups (e.g.
// plumbing.heatedWaterServices) are flattened correctly instead of being
// stringified to "[object Object]". Safe on undefined.
function collectRules(node) {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(collectRules);
  if (typeof node === "object") return Object.values(node).flatMap(collectRules);
  return [];
}

module.exports = { VICTORIAN_REGULATIONS, collectRules };
