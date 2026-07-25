/**
 * Loot protection flags on actor/token documents.
 * Flag path: flags.lootforge.looted
 */

export const FLAG_SCOPE = "lootforge";
export const FLAG_LOOTED = "looted";
export const SOCKET_EVENT = "module.lootforge";

/**
 * @param {TokenDocument|Actor} doc
 * @returns {boolean}
 */
export function isLooted(doc) {
  const actor = doc?.documentName === "Actor" ? doc : doc?.actor;
  if (!actor) return false;
  return Boolean(actor.getFlag?.(FLAG_SCOPE, FLAG_LOOTED) ?? actor.flags?.[FLAG_SCOPE]?.[FLAG_LOOTED]);
}

/**
 * Set or clear the looted flag, using a GM socket relay when the user lacks update permission.
 * @param {Actor} actor
 * @param {boolean} value
 * @returns {Promise<void>}
 */
export async function setLootedFlag(actor, value) {
  if (!actor) throw new Error("LootForge: no actor provided for loot flag.");

  if (canUpdateActor(actor)) {
    await actor.setFlag(FLAG_SCOPE, FLAG_LOOTED, value);
    return;
  }

  // Players usually cannot update NPC actors; ask an active GM via socket.
  return requestGMFlagUpdate(actor.uuid, value);
}

/**
 * @param {Actor} actor
 * @returns {boolean}
 */
export function canUpdateActor(actor) {
  try {
    return actor?.canUserModify?.(game.user, "update") ?? false;
  } catch (err) {
    console.error("LootForge | canUserModify check failed", err);
    return game.user?.isGM ?? false;
  }
}

/**
 * @param {string} actorUuid
 * @param {boolean} value
 * @returns {Promise<void>}
 */
function requestGMFlagUpdate(actorUuid, value) {
  return new Promise((resolve, reject) => {
    const requestId = foundry.utils.randomID();
    const timeout = setTimeout(() => {
      reject(new Error("LootForge: timed out waiting for GM to set loot flag."));
    }, 15000);

    const handler = (payload) => {
      if (payload?.type !== "flagResult" || payload.requestId !== requestId) return;
      game.socket.off(SOCKET_EVENT, handler);
      clearTimeout(timeout);
      if (payload.ok) resolve();
      else reject(new Error(payload.error || "LootForge: GM flag update failed."));
    };

    game.socket.on(SOCKET_EVENT, handler);
    game.socket.emit(SOCKET_EVENT, {
      type: "setFlag",
      requestId,
      actorUuid,
      value,
      userId: game.user.id
    });

    ui.notifications?.info(game.i18n.localize("LOOTFORGE.Notify.NeedGM"));
  });
}

/**
 * Register the GM-side socket listener. Call once on ready.
 */
export function registerLootFlagSocket() {
  game.socket.on(SOCKET_EVENT, async (payload) => {
    if (!game.user.isGM) return;
    if (payload?.type !== "setFlag") return;

    const { requestId, actorUuid, value } = payload;
    try {
      const actor = await fromUuid(actorUuid);
      if (!actor || actor.documentName !== "Actor") {
        throw new Error(`Actor not found: ${actorUuid}`);
      }
      await actor.setFlag(FLAG_SCOPE, FLAG_LOOTED, Boolean(value));
      game.socket.emit(SOCKET_EVENT, { type: "flagResult", requestId, ok: true });
    } catch (err) {
      console.error("LootForge | GM flag update failed", err);
      game.socket.emit(SOCKET_EVENT, {
        type: "flagResult",
        requestId,
        ok: false,
        error: err?.message ?? String(err)
      });
    }
  });
}

/**
 * GM helper: clear the looted flag for testing.
 * @param {Actor} actor
 * @returns {Promise<void>}
 */
export async function resetLootFlag(actor) {
  if (!game.user.isGM) {
    ui.notifications?.warn("Only the GM can reset loot flags.");
    return;
  }
  await actor.unsetFlag(FLAG_SCOPE, FLAG_LOOTED);
  ui.notifications?.info(
    game.i18n.format("LOOTFORGE.Notify.FlagReset", { name: actor.name })
  );
}
