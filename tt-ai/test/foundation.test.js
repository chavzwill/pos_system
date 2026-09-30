import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/core/tool-registry.js";
import { classifyAnswer, FACT_KIND } from "../src/core/policy.js";
import { partRecord } from "../src/knowledge/schema.js";

test("answers are unknown when no evidence exists", () => {
  assert.equal(classifyAnswer({ evidence: [] }), FACT_KIND.UNKNOWN);
});

test("v0 refuses write tools", () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.register({
    name: "pos.stock.adjust",
    mode: "write",
    permission: "inventory_adjust",
    execute: async () => ({}),
  }), /TT_AI_V0_READ_ONLY/);
});

test("tool execution inherits employee permission", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "pos.inventory.read",
    mode: "read",
    permission: "inventory",
    source: "pos",
    execute: async () => ({ quantityAvailable: 4 }),
  });

  await assert.rejects(
    registry.execute("pos.inventory.read", {}, {
      employeeId: "42",
      branchId: "1",
      permissions: ["dashboard"],
    }),
    /TT_AI_PERMISSION_DENIED/
  );

  const result = await registry.execute("pos.inventory.read", {}, {
    employeeId: "42",
    branchId: "1",
    permissions: ["inventory"],
  });
  assert.equal(result.quantityAvailable, 4);
});

test("part compatibility must be explicit evidence-backed data", () => {
  const part = partRecord({
    id: "part-1",
    name: "Air filter",
    compatibleMachineModelIds: ["model-9"],
    evidence: [{
      sourceId: "manual:abc:page-41",
      authority: "manufacturer",
      observedAt: "2026-09-30T00:00:00.000Z",
    }],
  });
  assert.deepEqual(part.compatibleMachineModelIds, ["model-9"]);
});
