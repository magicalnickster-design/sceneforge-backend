/**
 * LootForge — Gambits Forge
 * Interactive looting / harvesting prototype for D&D 5e.
 */

import { registerTokenHud } from "./ui/token-hud.js";
import { registerLootFlagSocket, resetLootFlag } from "./services/loot-flags.js";
import { lootBody } from "./services/loot-flow.js";

const MODULE_ID = "lootforge";

Hooks.once("init", () => {
  console.log("LootForge | Initializing");

  // Expose a tiny API for macros / console testing.
  globalThis.LootForge = {
    lootBody,
    resetLootFlag,
    /**
     * Macro helper: loot the currently targeted or selected defeated token.
     */
    async lootSelected() {
      const token = resolveSingleTargetToken();
      if (!token) {
        ui.notifications.warn(game.i18n.localize("LOOTFORGE.Notify.NoToken"));
        return;
      }
      return lootBody(token);
    }
  };
});

Hooks.once("setup", async () => {
  await loadTemplates([`modules/${MODULE_ID}/templates/loot-dialog.hbs`]);
});

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") {
    console.warn("LootForge | Active system is not dnd5e; module actions are disabled.");
    ui.notifications?.warn(game.i18n.localize("LOOTFORGE.Notify.WrongSystem"));
    return;
  }

  registerLootFlagSocket();
  registerTokenHud();
  console.log("LootForge | Ready (dnd5e)");
});

/**
 * Prefer a single targeted token; otherwise a single controlled token.
 * @returns {Token|null}
 */
function resolveSingleTargetToken() {
  const targets = [...(game.user.targets ?? [])];
  if (targets.length === 1) return targets[0];

  const selected = canvas.tokens?.controlled ?? [];
  if (selected.length === 1) return selected[0];

  return null;
}
