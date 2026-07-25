/**
 * D&D 5e skill rolling helpers for LootForge.
 */

/**
 * Resolve the actor that should make the loot skill check.
 * Prefers the user's assigned character, then an owned selected character token.
 * @returns {Actor|null}
 */
export function resolveLooterActor() {
  if (game.user?.character) return game.user.character;

  const selected = canvas.tokens?.controlled ?? [];
  const ownedCharacter = selected.find(
    (t) => t.actor?.type === "character" && t.actor.isOwner
  );
  if (ownedCharacter?.actor) return ownedCharacter.actor;

  // GMs may roll with any selected character token.
  if (game.user.isGM) {
    const anyCharacter = selected.find((t) => t.actor?.type === "character");
    if (anyCharacter?.actor) return anyCharacter.actor;
  }

  return null;
}

/**
 * Request a dnd5e skill roll and return total + natural d20 result.
 * Uses Actor#rollSkill({ skill }) which returns D20Roll[]|null in modern dnd5e.
 *
 * @param {Actor} looter
 * @param {"sur"|"inv"} skill
 * @returns {Promise<{ total: number, natural: number, rolls: object[] }|null>}
 */
export async function requestSkillRoll(looter, skill) {
  if (!looter?.rollSkill) {
    console.error("LootForge | Actor.rollSkill is unavailable. Is the dnd5e system active?");
    ui.notifications?.error(game.i18n.localize("LOOTFORGE.Notify.WrongSystem"));
    return null;
  }

  // dnd5e v3+/v4+/v5: config object with skill abbreviation.
  const rolls = await looter.rollSkill({ skill });
  if (!rolls?.length) return null;

  const primary = rolls[0];
  const total = Number(primary.total ?? 0);
  const natural = extractNaturalDie(primary);

  return { total, natural, rolls };
}

/**
 * Read the natural d20 face from a Foundry / dnd5e roll.
 * @param {Roll} roll
 * @returns {number}
 */
export function extractNaturalDie(roll) {
  try {
    // Prefer official d20 dice on the roll (dnd5e D20Roll).
    const d20 = roll.dice?.find((d) => d.faces === 20) ?? roll.dice?.[0];
    if (d20?.results?.length) {
      const kept = d20.results.find((r) => !r.discarded) ?? d20.results[0];
      if (kept?.result != null) return Number(kept.result);
    }

    // Fallback: some roll wrappers expose terms.
    const term = roll.terms?.find((t) => t.faces === 20);
    if (term?.results?.length) {
      const kept = term.results.find((r) => !r.discarded) ?? term.results[0];
      if (kept?.result != null) return Number(kept.result);
    }
  } catch (err) {
    console.warn("LootForge | Could not read natural die result", err);
  }
  return 0;
}
