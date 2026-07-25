/**
 * End-to-end "Loot Body" workflow for the prototype.
 */

import { classifyCreature } from "./creature-classifier.js";
import { generateLoot } from "./loot-generator.js";
import { isLooted, setLootedFlag } from "./loot-flags.js";
import { requestSkillRoll, resolveLooterActor } from "./roll-service.js";
import { showLootDialog } from "../ui/loot-dialog.js";

/**
 * Whether a token/actor counts as defeated for looting.
 * @param {Token|TokenDocument} token
 * @returns {boolean}
 */
export function isDefeatedToken(token) {
  const actor = token?.actor;
  if (!actor) return false;

  const hp = actor.system?.attributes?.hp?.value;
  if (typeof hp === "number" && hp <= 0) return true;

  // Foundry status effects (dead / defeated overlays).
  if (actor.statuses?.has?.("dead") || actor.statuses?.has?.("defeated")) return true;

  // Active combat defeated flag.
  const tokenId = token.id ?? token.document?.id;
  const combatant = game.combat?.combatants?.find((c) => c.tokenId === tokenId);
  if (combatant?.isDefeated) return true;

  return false;
}

/**
 * Permission check: observer access is enough to attempt looting in the prototype.
 * @param {Actor} creatureActor
 * @returns {boolean}
 */
export function canLootCreature(creatureActor) {
  if (game.user.isGM) return true;
  try {
    return creatureActor.testUserPermission(game.user, "OBSERVER");
  } catch (err) {
    console.warn("LootForge | permission check failed", err);
    return Boolean(creatureActor?.visible);
  }
}

/**
 * Run the full loot flow for a defeated creature token.
 * @param {Token} token
 * @returns {Promise<void>}
 */
export async function lootBody(token) {
  if (game.system?.id !== "dnd5e") {
    ui.notifications.error(game.i18n.localize("LOOTFORGE.Notify.WrongSystem"));
    return;
  }

  const creatureActor = token?.actor;
  if (!creatureActor) {
    ui.notifications.warn(game.i18n.localize("LOOTFORGE.Notify.NoToken"));
    return;
  }

  if (!isDefeatedToken(token)) {
    ui.notifications.warn(
      game.i18n.format("LOOTFORGE.Notify.NotDefeated", { name: creatureActor.name })
    );
    return;
  }

  if (!canLootCreature(creatureActor)) {
    ui.notifications.warn(
      game.i18n.format("LOOTFORGE.Notify.NoPermission", { name: creatureActor.name })
    );
    return;
  }

  if (isLooted(creatureActor)) {
    ui.notifications.warn(
      game.i18n.format("LOOTFORGE.Notify.AlreadyLooted", { name: creatureActor.name })
    );
    return;
  }

  const looter = resolveLooterActor();
  if (!looter) {
    ui.notifications.warn(game.i18n.localize("LOOTFORGE.Notify.NoLooter"));
    return;
  }

  const classification = classifyCreature(creatureActor);
  const roll = await requestSkillRoll(looter, classification.skill);
  if (!roll) {
    ui.notifications.info(game.i18n.localize("LOOTFORGE.Notify.RollCancelled"));
    return;
  }

  const loot = generateLoot({
    creatureActor,
    rollTotal: roll.total,
    naturalDie: roll.natural
  });

  if (!loot) {
    ui.notifications.warn(
      game.i18n.format("LOOTFORGE.Notify.NoTable", { name: creatureActor.name })
    );
    return;
  }

  // Mark looted before claim so refreshes / double-clicks cannot re-roll.
  try {
    await setLootedFlag(creatureActor, true);
  } catch (err) {
    console.error("LootForge | failed to set looted flag", err);
    ui.notifications.error(err.message ?? "Failed to mark creature as looted.");
    return;
  }

  await showLootDialog({
    creatureName: creatureActor.name,
    skill: classification.skill,
    interaction: classification.interaction,
    rollTotal: roll.total,
    naturalDie: roll.natural,
    tier: loot.tier,
    items: loot.items,
    natural20Bonus: loot.natural20Bonus,
    looter
  });
}
