import test from "node:test";
import assert from "node:assert/strict";
import { seed, findPlatinumCard } from "../scripts/seedPlatinumAirbnb.js";

function fakeRepo(benefits) {
  const calls = [];
  return {
    calls,
    getCatalog: async () => [{ id: 1, issuer: "American Express", product: "Platinum Card", nickname: "Plat", benefits }],
    createBenefit: async (v) => { calls.push(["createBenefit", v]); return { id: 99, rules: [], ...v }; },
    updateBenefit: async (id, v) => { calls.push(["updateBenefit", id, v]); return { id, ...v }; },
    assertValidRegex: async () => {},
    createRule: async (v) => { calls.push(["createRule", v]); return v; },
  };
}

test("renames the old hotel credit in place and creates the Airbnb credit + rule", async () => {
  const repo = fakeRepo([{ id: 5, name: "Semi-Annual Hotel Credit", amount_limit: 300, rules: [] }]);
  await seed({ repo });
  assert.deepEqual(repo.calls.map((c) => c[0]), ["updateBenefit", "createBenefit", "createRule"]);
  assert.equal(repo.calls[0][1], 5);
  assert.equal(repo.calls[0][2].name, "Lodging Credit");
  assert.equal(repo.calls[2][1].benefit_id, 99);
});

test("dry run writes nothing", async () => {
  const repo = fakeRepo([{ id: 5, name: "Semi-Annual Hotel Credit", rules: [] }]);
  await seed({ repo, dryRun: true });
  assert.equal(repo.calls.length, 0);
});

test("second run is a no-op", async () => {
  const first = fakeRepo([{ id: 5, name: "Semi-Annual Hotel Credit", rules: [] }]);
  await seed({ repo: first });
  const [, , lodging] = [0, 0, first.calls[0][2]];
  const second = fakeRepo([
    { id: 5, ...lodging },
    { id: 99, name: "Airbnb Experiences Credit", rules: [{ id: 1 }] },
  ]);
  await seed({ repo: second });
  assert.equal(second.calls.length, 0);
});

test("errors unless exactly one Platinum card", () => {
  assert.throws(() => findPlatinumCard([]), /exactly one/);
});
