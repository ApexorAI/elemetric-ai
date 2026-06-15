#!/usr/bin/env node
// Lints the Victorian regulations KB. Run before committing reg changes:
//     node scripts/validate-regulations.js
//
// Checks:
//   • every rule is a non-empty string (no stray objects/numbers as leaves)
//   • every rule cites a standard + clause (AS/NZS / AS / NCC + cl/Clause/Table/Appendix)
//   • no exact-duplicate rule text within a trade
// Exits non-zero on any error so it can gate a pre-commit hook or CI later.

const path = require("path");
const { VICTORIAN_REGULATIONS, collectRules } = require(path.join(__dirname, "..", "regulations"));

// A rule should reference a recognised standard family AND a clause-like locator.
const STANDARD_RE = /\b(AS\/NZS|AS|NCC|ANSI\/AWWA)\b/;
const LOCATOR_RE = /\b(cl|clause|table|appendix|section)\b/i;

const errors = [];
const warnings = [];

// Walk each trade so duplicate-detection and messages are scoped per trade.
for (const [trade, node] of Object.entries(VICTORIAN_REGULATIONS)) {
  const rules = collectRules(node);
  if (rules.length === 0) {
    warnings.push(`[${trade}] no rules found`);
    continue;
  }
  const seen = new Map();
  for (const rule of rules) {
    if (typeof rule !== "string" || rule.trim() === "") {
      errors.push(`[${trade}] non-string or empty rule leaf: ${JSON.stringify(rule)}`);
      continue;
    }
    if (!STANDARD_RE.test(rule)) {
      errors.push(`[${trade}] rule missing a standard reference (AS/NZS, AS, NCC…):\n    "${rule}"`);
    }
    if (!LOCATOR_RE.test(rule)) {
      warnings.push(`[${trade}] rule has no clause/table/appendix locator:\n    "${rule}"`);
    }
    const key = rule.replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(key)) {
      errors.push(`[${trade}] duplicate rule text:\n    "${rule}"`);
    } else {
      seen.set(key, true);
    }
  }
}

const total = Object.values(VICTORIAN_REGULATIONS).reduce((n, node) => n + collectRules(node).length, 0);

for (const w of warnings) console.warn("WARN  " + w);
for (const e of errors) console.error("ERROR " + e);

console.log(`\n${total} rules across ${Object.keys(VICTORIAN_REGULATIONS).length} trades — ` +
  `${errors.length} error(s), ${warnings.length} warning(s).`);

process.exit(errors.length > 0 ? 1 : 0);
