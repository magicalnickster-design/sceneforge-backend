# LootForge (Prototype)

Interactive looting and harvesting for defeated creatures in **Foundry VTT** (D&D 5e).

Part of **Gambits Forge**. This first prototype supports wolf harvesting via a Survival roll.

## Target versions

| Component | Target |
|-----------|--------|
| Foundry VTT | v12+ (verified against v13 APIs) |
| Game system | `dnd5e` 3.0+ (skill API: `Actor#rollSkill({ skill })`) |

This repository also contains the SceneForge backend under `/src`. LootForge lives entirely in `/lootforge` as a Foundry module package.

## What the prototype does

1. Right-click a **defeated** Wolf token → Token HUD → **Loot Body**
2. Classifies the creature as **Harvest** (beast → Survival)
3. Asks your assigned character to roll **Survival**
4. Generates loot instantly from a local table (pelt / fang / meat)
5. Shows a loot dialog with tier, items, and **Claim Loot**
6. Sets `flags.lootforge.looted = true` so the body cannot be looted again
7. GM can reset the flag from the Token HUD (rotate icon) when testing

## Install in a Foundry development world

### Option A — symlink (recommended while developing)

1. Clone this repo (or copy the `lootforge` folder).
2. Symlink the module into your Foundry Data folder:

```bash
# Linux / macOS example
ln -s /absolute/path/to/repo/lootforge \
  "/path/to/FoundryVTT/Data/modules/lootforge"
```

Windows (Admin PowerShell):

```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:LOCALAPPDATA\FoundryVTT\Data\modules\lootforge" `
  -Target "C:\path\to\repo\lootforge"
```

3. Launch Foundry → open your **dnd5e** world → **Settings → Manage Modules** → enable **LootForge**.
4. Reload the world.

### Option B — copy

Copy the `lootforge` directory into `Data/modules/lootforge` and enable the module as above.

## Test script (Wolf harvest)

1. Create or import a **Wolf** NPC (creature type **Beast**, CR **1/4**).
2. Place its token on a scene.
3. Assign yourself a player character (User Config → Character), or select your PC token as GM.
4. Reduce the Wolf to **0 HP** (or mark it defeated / apply Dead).
5. Right-click the Wolf token to open the Token HUD.
6. Click the sack icon (**Loot Body**).
7. Confirm the Survival roll for your character.
8. Verify the dialog shows creature name, skill, total, tier, and items such as:
   - Raw Meat
   - Wolf Fang
   - Wolf Pelt
9. Click **Claim Loot** — items should appear on your character (type `loot`).
10. Open the Wolf HUD again — **Loot Body** should be gone; attempting via `LootForge.lootSelected()` warns that it is already looted.
11. As GM, use the HUD reset icon to clear `flags.lootforge.looted` and re-test.

### Console helpers

```js
// Loot targeted or selected token
await LootForge.lootSelected();

// GM: clear flag on selected token's actor
await LootForge.resetLootFlag(canvas.tokens.controlled[0].actor);
```

## Module layout

```text
lootforge/
├── module.json
├── scripts/
│   ├── main.js
│   ├── ui/
│   │   ├── token-hud.js
│   │   └── loot-dialog.js
│   ├── services/
│   │   ├── creature-classifier.js
│   │   ├── roll-service.js
│   │   ├── loot-generator.js
│   │   ├── loot-flags.js
│   │   └── loot-flow.js
│   └── data/
│       └── prototype-loot-tables.js
├── styles/
│   └── lootforge.css
├── templates/
│   └── loot-dialog.hbs
└── lang/
    └── en.json
```

## Roll tiers

| Total | Tier |
|------:|------|
| 1–9 | Poor |
| 10–14 | Common |
| 15–19 | Good |
| 20–24 | Rare |
| 25+ | Best |

CR clamps the maximum tier (wolf CR &lt; 1 → max **Good**). Natural 20 maximizes quantities and adds a bonus item when defined on the table.

## Assumptions / APIs to verify in your install

1. **`Actor#rollSkill({ skill: "sur" })`** returns `D20Roll[]` with `.total` and d20 `.dice` results (dnd5e v3+ / v4 / v5). Older dnd5e used `rollSkill("sur")` — not supported here.
2. **Creature type** is at `actor.system.details.type.value` (`beast`, `humanoid`, …).
3. **CR** is at `actor.system.details.cr`.
4. **Defeated** detection uses HP ≤ 0, `actor.statuses` (`dead` / `defeated`), or combatant `isDefeated`.
5. **Token HUD** hook `renderTokenHUD` receives an `HTMLElement` on v13 (jQuery on older v12); both are handled.
6. **`foundry.applications.api.DialogV2`** is available (Foundry v12+).
7. **Item type `"loot"`** exists in dnd5e for claimed harvest materials.
8. **Players cannot update NPC flags** — a GM socket relay (`module.lootforge`) sets `flags.lootforge.looted`. An active GM client must be connected for players to finish looting.
9. **Assigned character** via `game.user.character` is the preferred looter / claim target.

## Out of scope (by design)

AI loot, auth/subscriptions, crafting, biomes, multi-system support, and full item compendiums.
