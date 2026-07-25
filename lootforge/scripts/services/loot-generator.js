/**
 * Instant local loot generation from prototype tables (no AI / external APIs).
 */

import {
  LOOT_TABLES,
  clampTier,
  maxTierFromCR,
  resolveLootTableKey,
  tierFromRollTotal
} from "../data/prototype-loot-tables.js";

/**
 * @typedef {object} GeneratedLootItem
 * @property {string} name
 * @property {number} quantity
 */

/**
 * @typedef {object} LootResult
 * @property {string} tableKey
 * @property {string} tier
 * @property {string} rolledTier
 * @property {GeneratedLootItem[]} items
 * @property {boolean} natural20Bonus
 */

/**
 * Roll an inclusive integer in [min, max].
 * @param {number} min
 * @param {number} max
 * @param {() => number} [rng]
 * @returns {number}
 */
export function rollQuantity(min, max, rng = Math.random) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

/**
 * Expand table entries into concrete item stacks.
 * @param {Array<{name: string, quantity: [number, number]}>} entries
 * @param {{ maximize?: boolean, rng?: () => number }} [options]
 * @returns {GeneratedLootItem[]}
 */
export function materializeEntries(entries, options = {}) {
  const rng = options.rng ?? Math.random;
  const maximize = Boolean(options.maximize);
  return (entries ?? []).map((entry) => {
    const [min, max] = entry.quantity ?? [1, 1];
    return {
      name: entry.name,
      quantity: maximize ? Math.max(min, max) : rollQuantity(min, max, rng)
    };
  });
}

/**
 * Generate loot for a creature from a completed skill roll.
 * @param {object} params
 * @param {Actor} params.creatureActor
 * @param {number} params.rollTotal
 * @param {number} params.naturalDie
 * @param {() => number} [params.rng]
 * @returns {LootResult|null}
 */
export function generateLoot({ creatureActor, rollTotal, naturalDie, rng = Math.random }) {
  const tableKey = resolveLootTableKey(creatureActor);
  if (!tableKey) return null;

  const table = LOOT_TABLES[tableKey];
  if (!table) return null;

  const rolledTier = tierFromRollTotal(Number(rollTotal) || 0);
  const cr = creatureActor?.system?.details?.cr;
  const tier = clampTier(rolledTier, table.maxTier ?? "best", maxTierFromCR(cr));
  const isNat20 = Number(naturalDie) === 20;

  let items = materializeEntries(table[tier], { maximize: isNat20, rng });

  if (isNat20 && table.bonusNat20) {
    items = items.concat(materializeEntries([table.bonusNat20], { maximize: true, rng }));
  }

  // Merge duplicate names for cleaner dialog / claiming.
  items = mergeStacks(items);

  return {
    tableKey,
    tier,
    rolledTier,
    items,
    natural20Bonus: isNat20
  };
}

/**
 * @param {GeneratedLootItem[]} items
 * @returns {GeneratedLootItem[]}
 */
export function mergeStacks(items) {
  const map = new Map();
  for (const item of items) {
    const prev = map.get(item.name) ?? 0;
    map.set(item.name, prev + Number(item.quantity || 0));
  }
  return [...map.entries()].map(([name, quantity]) => ({ name, quantity }));
}

export { LOOT_TABLES, resolveLootTableKey, tierFromRollTotal };
