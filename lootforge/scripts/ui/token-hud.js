/**
 * Token HUD integration — "Loot Body" button for players.
 * Uses renderTokenHUD (works without actor-sheet access).
 */

import { lootBody, isDefeatedToken } from "../services/loot-flow.js";
import { isLooted, resetLootFlag } from "../services/loot-flags.js";

/**
 * Register Token HUD hooks.
 */
export function registerTokenHud() {
  Hooks.on("renderTokenHUD", (hud, html) => {
    try {
      injectLootButton(hud, html);
    } catch (err) {
      console.error("LootForge | Token HUD render failed", err);
    }
  });
}

/**
 * @param {TokenHUD} hud
 * @param {HTMLElement|JQuery} html
 */
function injectLootButton(hud, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;

  const token = hud.object;
  const actor = token?.actor;
  if (!actor) return;

  // Only show for likely loot targets (NPCs / defeated creatures).
  if (actor.type === "character" && !game.user.isGM) return;

  const defeated = isDefeatedToken(token);
  const looted = isLooted(actor);
  if (!defeated && !game.user.isGM) return;

  const col = root.querySelector(".col.right") ?? root.querySelector(".col.left");
  if (!col) return;

  if (defeated && !looted) {
    const button = createHudButton({
      title: game.i18n.localize("LOOTFORGE.LootBody"),
      iconClass: "fa-solid fa-sack",
      cssClass: "lootforge-loot-body"
    });
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await lootBody(token);
      hud.clear();
    });
    col.appendChild(button);
  }

  // GM testing aid: clear the permanent loot flag.
  if (game.user.isGM && looted) {
    const reset = createHudButton({
      title: game.i18n.localize("LOOTFORGE.ResetLoot"),
      iconClass: "fa-solid fa-rotate-left",
      cssClass: "lootforge-reset-loot"
    });
    reset.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await resetLootFlag(actor);
      hud.clear();
    });
    col.appendChild(reset);
  }
}

/**
 * @param {{ title: string, iconClass: string, cssClass: string }} opts
 * @returns {HTMLElement}
 */
function createHudButton({ title, iconClass, cssClass }) {
  const button = document.createElement("div");
  button.classList.add("control-icon", cssClass);
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `<i class="${iconClass}"></i>`;
  return button;
}
