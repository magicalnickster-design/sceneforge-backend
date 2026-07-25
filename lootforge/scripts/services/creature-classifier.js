/**
 * Classify a D&D 5e actor as Search (Investigation) or Harvest (Survival).
 */

/** Creature types that are searched for carried goods. */
const SEARCH_TYPES = new Set(["humanoid", "giant"]);

/** Creature types that are harvested for parts. */
const HARVEST_TYPES = new Set([
  "beast",
  "monstrosity",
  "dragon",
  "aberration",
  "plant",
  "ooze",
  "undead",
  "fiend",
  "celestial",
  "elemental",
  "fey"
]);

/**
 * @typedef {"search"|"harvest"} InteractionType
 */

/**
 * @typedef {object} Classification
 * @property {InteractionType} interaction
 * @property {"inv"|"sur"} skill
 * @property {string} creatureType
 * @property {number|null} cr
 */

/**
 * Read creature type and CR from a dnd5e actor.
 * @param {Actor} actor
 * @returns {{ creatureType: string, cr: number|null }}
 */
export function readCreatureDetails(actor) {
  const creatureType = String(actor?.system?.details?.type?.value ?? "").toLowerCase();
  const rawCr = actor?.system?.details?.cr;
  const cr = rawCr === null || rawCr === undefined || rawCr === ""
    ? null
    : Number(rawCr);
  return {
    creatureType,
    cr: Number.isFinite(cr) ? cr : null
  };
}

/**
 * Determine Search vs Harvest for a defeated creature.
 * Constructs default to Search (carried gear); unknown types default to Harvest.
 * @param {Actor} actor
 * @returns {Classification}
 */
export function classifyCreature(actor) {
  const { creatureType, cr } = readCreatureDetails(actor);

  if (SEARCH_TYPES.has(creatureType) || creatureType === "construct") {
    return {
      interaction: "search",
      skill: "inv",
      creatureType,
      cr
    };
  }

  if (HARVEST_TYPES.has(creatureType) || !creatureType) {
    return {
      interaction: "harvest",
      skill: "sur",
      creatureType: creatureType || "unknown",
      cr
    };
  }

  // Unlisted types: prefer search for intelligent-looking NPCs with type custom text.
  return {
    interaction: "search",
    skill: "inv",
    creatureType,
    cr
  };
}
