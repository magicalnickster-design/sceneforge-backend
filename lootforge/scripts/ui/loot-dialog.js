/**
 * Player-facing loot result dialog + claim handling.
 */

/**
 * @typedef {object} LootDialogData
 * @property {string} creatureName
 * @property {"sur"|"inv"} skill
 * @property {"search"|"harvest"} interaction
 * @property {number} rollTotal
 * @property {number} naturalDie
 * @property {string} tier
 * @property {Array<{name: string, quantity: number}>} items
 * @property {boolean} natural20Bonus
 * @property {Actor|null} looter
 */

/**
 * Show loot results and offer Claim / Close.
 * Claim creates simple dnd5e "loot" items on the assigned character when possible;
 * otherwise posts linked placeholders to chat.
 *
 * @param {LootDialogData} data
 * @returns {Promise<void>}
 */
export async function showLootDialog(data) {
  const content = await renderTemplate("modules/lootforge/templates/loot-dialog.hbs", {
    creatureName: data.creatureName,
    rollTotal: data.rollTotal,
    naturalDie: data.naturalDie,
    tier: data.tier,
    tierLabel: game.i18n.localize(`LOOTFORGE.Tier.${data.tier}`),
    skillLabel: game.i18n.localize(`LOOTFORGE.Skill.${data.skill}`),
    interactionLabel: game.i18n.localize(`LOOTFORGE.Interaction.${data.interaction}`),
    items: data.items,
    natural20Bonus: data.natural20Bonus
  });

  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2) {
    // Extremely old Foundry fallback — should not happen on v12+.
    console.error("LootForge | DialogV2 unavailable");
    await ChatMessage.create({
      content: `<p><strong>LootForge:</strong> ${data.creatureName}</p>${formatItemsHtml(data.items)}`,
      speaker: ChatMessage.getSpeaker({ actor: data.looter })
    });
    return;
  }

  await DialogV2.wait({
    window: {
      title: game.i18n.format("LOOTFORGE.Dialog.Title", { name: data.creatureName }),
      icon: "fa-solid fa-sack"
    },
    content,
    buttons: [
      {
        action: "claim",
        label: game.i18n.localize("LOOTFORGE.Dialog.Claim"),
        icon: "fa-solid fa-hand",
        default: true,
        callback: async () => {
          await claimLoot(data);
          return "claim";
        }
      },
      {
        action: "close",
        label: game.i18n.localize("LOOTFORGE.Dialog.Close"),
        icon: "fa-solid fa-xmark"
      }
    ],
    classes: ["lootforge-app"],
    position: { width: 420 }
  });
}

/**
 * @param {LootDialogData} data
 * @returns {Promise<void>}
 */
async function claimLoot(data) {
  const items = data.items ?? [];
  if (!items.length) {
    ui.notifications.info(game.i18n.localize("LOOTFORGE.Dialog.Empty"));
    return;
  }

  const looter = data.looter;
  if (looter && looter.isOwner) {
    try {
      const created = await createLootItemsOnActor(looter, items);
      if (created?.length) {
        ui.notifications.info(
          game.i18n.format("LOOTFORGE.Notify.LootClaimed", { name: looter.name })
        );
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: looter }),
          content: `<p><strong>${looter.name}</strong> claimed loot from <em>${data.creatureName}</em>:</p>${formatItemsHtml(items)}`
        });
        return;
      }
    } catch (err) {
      console.error("LootForge | failed to create items on actor", err);
    }
  }

  // Reliable fallback: post to chat so the player (or GM) can drag/create manually.
  await postLootToChat(data);
  ui.notifications.info(game.i18n.localize("LOOTFORGE.Notify.LootPosted"));
}

/**
 * Create temporary dnd5e loot-type items on the claiming character.
 * @param {Actor} actor
 * @param {Array<{name: string, quantity: number}>} items
 * @returns {Promise<Item[]>}
 */
async function createLootItemsOnActor(actor, items) {
  // Keep system data minimal for dnd5e version variance (v3–v5).
  const docs = items.map((item) => ({
    name: item.name,
    type: "loot",
    img: "icons/commodities/materials/bone-teeth-brown.webp",
    system: {
      quantity: item.quantity,
      description: {
        value: "<p>Harvested via LootForge.</p>"
      }
    }
  }));

  return actor.createEmbeddedDocuments("Item", docs);
}

/**
 * @param {LootDialogData} data
 * @returns {Promise<void>}
 */
async function postLootToChat(data) {
  const looterName = data.looter?.name ?? game.user.name;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: data.looter ?? undefined }),
    content: `
      <div class="lootforge-chat">
        <p><strong>LootForge</strong> — ${looterName} looted <em>${data.creatureName}</em></p>
        <p>${game.i18n.localize(`LOOTFORGE.Skill.${data.skill}`)}:
          <strong>${data.rollTotal}</strong>
          (${game.i18n.localize(`LOOTFORGE.Tier.${data.tier}`)})</p>
        ${formatItemsHtml(data.items)}
        <p><em>No assigned character available to receive items automatically. Create or drag these items onto a sheet.</em></p>
      </div>
    `
  });
}

/**
 * @param {Array<{name: string, quantity: number}>} items
 * @returns {string}
 */
function formatItemsHtml(items) {
  if (!items?.length) return `<p>${game.i18n.localize("LOOTFORGE.Dialog.Empty")}</p>`;
  const rows = items
    .map((i) => `<li><strong>${foundry.utils.escapeHTML(i.name)}</strong> ×${i.quantity}</li>`)
    .join("");
  return `<ul>${rows}</ul>`;
}
