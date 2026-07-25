/**
 * Prototype loot tables keyed by creature slug.
 * Replace with compendium-backed data in a later version.
 *
 * quantity: [min, max] inclusive range rolled per item entry.
 * maxTier: highest tier this creature can produce (CR-style gate).
 * bonusNat20: optional extra item granted on a natural 20.
 */

/** @typedef {"poor"|"common"|"good"|"rare"|"best"} LootTier */

/** @type {LootTier[]} */
export const LOOT_TIERS = ["poor", "common", "good", "rare", "best"];

/**
 * Map a final roll total to a loot tier key.
 * @param {number} total
 * @returns {LootTier}
 */
export function tierFromRollTotal(total) {
  if (total >= 25) return "best";
  if (total >= 20) return "rare";
  if (total >= 15) return "good";
  if (total >= 10) return "common";
  return "poor";
}

/**
 * Challenge rating soft-cap for available tiers.
 * A wolf (CR 1/4) never reaches "best" even on a 25+.
 * @param {number|null|undefined} cr
 * @returns {LootTier}
 */
export function maxTierFromCR(cr) {
  const value = Number(cr);
  if (!Number.isFinite(value)) return "common";
  if (value < 1) return "good";
  if (value < 5) return "rare";
  return "best";
}

/**
 * Clamp a rolled tier so it never exceeds the lower of table/CR caps.
 * @param {LootTier} rolled
 * @param {LootTier} tableMax
 * @param {LootTier} crMax
 * @returns {LootTier}
 */
export function clampTier(rolled, tableMax, crMax) {
  const rolledIndex = LOOT_TIERS.indexOf(rolled);
  const maxIndex = Math.min(
    LOOT_TIERS.indexOf(tableMax),
    LOOT_TIERS.indexOf(crMax)
  );
  const safeMax = maxIndex < 0 ? 0 : maxIndex;
  const safeRolled = rolledIndex < 0 ? 0 : rolledIndex;
  return LOOT_TIERS[Math.min(safeRolled, safeMax)];
}

export const LOOT_TABLES = {
  wolf: {
    label: "Wolf",
    /** Match against actor name (case-insensitive) or details.type.subtype. */
    matchNames: ["wolf"],
    creatureTypes: ["beast"],
    maxTier: "best",
    poor: [
      { name: "Raw Meat", quantity: [1, 1] }
    ],
    common: [
      { name: "Raw Meat", quantity: [1, 2] },
      { name: "Wolf Fang", quantity: [1, 1] }
    ],
    good: [
      { name: "Wolf Pelt", quantity: [1, 1] },
      { name: "Wolf Fang", quantity: [1, 2] },
      { name: "Raw Meat", quantity: [1, 3] }
    ],
    rare: [
      { name: "Pristine Wolf Pelt", quantity: [1, 1] },
      { name: "Large Wolf Fang", quantity: [1, 2] },
      { name: "Raw Meat", quantity: [2, 3] }
    ],
    best: [
      { name: "Pristine Wolf Pelt", quantity: [1, 1] },
      { name: "Alpha Wolf Fang", quantity: [1, 1] },
      { name: "Raw Meat", quantity: [2, 4] }
    ],
    bonusNat20: { name: "Lucky Wolf Charm", quantity: [1, 1] }
  }
};

/**
 * Resolve a loot table key from an actor document-like object.
 * @param {{ name?: string, system?: { details?: { type?: { value?: string, subtype?: string } } } }} actor
 * @returns {string|null}
 */
export function resolveLootTableKey(actor) {
  const name = String(actor?.name ?? "").trim().toLowerCase();
  const subtype = String(actor?.system?.details?.type?.subtype ?? "").trim().toLowerCase();

  for (const [key, table] of Object.entries(LOOT_TABLES)) {
    const names = table.matchNames ?? [key];
    if (names.some((n) => name === n || name.includes(n) || subtype === n)) {
      return key;
    }
  }

  // Fallback: beast named like a known table key
  const type = String(actor?.system?.details?.type?.value ?? "").toLowerCase();
  if (type && LOOT_TABLES[type]) return type;

  return null;
}
