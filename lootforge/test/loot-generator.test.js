/**
 * Pure-logic tests for LootForge prototype (no Foundry runtime required).
 * Run from repo root: node --test lootforge/test/*.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clampTier,
  maxTierFromCR,
  resolveLootTableKey,
  tierFromRollTotal
} from "../scripts/data/prototype-loot-tables.js";
import {
  generateLoot,
  mergeStacks,
  rollQuantity
} from "../scripts/services/loot-generator.js";
import { classifyCreature } from "../scripts/services/creature-classifier.js";

describe("tierFromRollTotal", () => {
  it("maps bands correctly", () => {
    assert.equal(tierFromRollTotal(1), "poor");
    assert.equal(tierFromRollTotal(9), "poor");
    assert.equal(tierFromRollTotal(10), "common");
    assert.equal(tierFromRollTotal(14), "common");
    assert.equal(tierFromRollTotal(15), "good");
    assert.equal(tierFromRollTotal(19), "good");
    assert.equal(tierFromRollTotal(20), "rare");
    assert.equal(tierFromRollTotal(24), "rare");
    assert.equal(tierFromRollTotal(25), "best");
  });
});

describe("CR tier clamp", () => {
  it("caps wolf-level CR below best/rare as designed", () => {
    assert.equal(maxTierFromCR(0.25), "good");
    assert.equal(clampTier("best", "best", maxTierFromCR(0.25)), "good");
    assert.equal(clampTier("rare", "best", maxTierFromCR(0.25)), "good");
    assert.equal(clampTier("common", "best", maxTierFromCR(0.25)), "common");
  });

  it("allows best for high CR", () => {
    assert.equal(maxTierFromCR(11), "best");
    assert.equal(clampTier("best", "best", maxTierFromCR(11)), "best");
  });
});

describe("resolveLootTableKey", () => {
  it("matches wolf by name", () => {
    assert.equal(resolveLootTableKey({ name: "Wolf" }), "wolf");
    assert.equal(resolveLootTableKey({ name: "Dire Wolf" }), "wolf");
  });
});

describe("classifyCreature", () => {
  it("harvests beasts with Survival", () => {
    const result = classifyCreature({
      system: { details: { type: { value: "beast" }, cr: 0.25 } }
    });
    assert.equal(result.interaction, "harvest");
    assert.equal(result.skill, "sur");
  });

  it("searches humanoids with Investigation", () => {
    const result = classifyCreature({
      system: { details: { type: { value: "humanoid" }, cr: 1 } }
    });
    assert.equal(result.interaction, "search");
    assert.equal(result.skill, "inv");
  });
});

describe("generateLoot", () => {
  const wolf = {
    name: "Wolf",
    system: { details: { type: { value: "beast" }, cr: 0.25 } }
  };

  it("returns wolf items for a good harvest roll", () => {
    const loot = generateLoot({
      creatureActor: wolf,
      rollTotal: 16,
      naturalDie: 12,
      rng: () => 0 // always min quantity
    });
    assert.ok(loot);
    assert.equal(loot.tier, "good");
    assert.deepEqual(
      loot.items.map((i) => i.name).sort(),
      ["Raw Meat", "Wolf Fang", "Wolf Pelt"].sort()
    );
  });

  it("never exceeds CR cap for wolves even on 25+", () => {
    const loot = generateLoot({
      creatureActor: wolf,
      rollTotal: 30,
      naturalDie: 15,
      rng: () => 0
    });
    assert.equal(loot.tier, "good");
    assert.ok(!loot.items.some((i) => i.name.includes("Alpha")));
  });

  it("adds natural 20 bonus item and maximizes quantities", () => {
    const loot = generateLoot({
      creatureActor: wolf,
      rollTotal: 18,
      naturalDie: 20,
      rng: () => 0
    });
    assert.equal(loot.natural20Bonus, true);
    assert.ok(loot.items.some((i) => i.name === "Lucky Wolf Charm"));
    const meat = loot.items.find((i) => i.name === "Raw Meat");
    assert.equal(meat.quantity, 3); // good tier max
  });
});

describe("helpers", () => {
  it("rollQuantity stays in range", () => {
    for (let i = 0; i < 20; i++) {
      const n = rollQuantity(1, 3, () => i / 20);
      assert.ok(n >= 1 && n <= 3);
    }
  });

  it("mergeStacks combines duplicates", () => {
    assert.deepEqual(
      mergeStacks([
        { name: "Raw Meat", quantity: 1 },
        { name: "Raw Meat", quantity: 2 }
      ]),
      [{ name: "Raw Meat", quantity: 3 }]
    );
  });
});
