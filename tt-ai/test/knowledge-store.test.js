import test from "node:test";
import assert from "node:assert/strict";
import { KnowledgeStore } from "../src/knowledge/store.js";

test("compatibility cannot exist without an evidence source", () => {
  const store = new KnowledgeStore();
  store.upsertMachineModel({ id: "m1", brand: "Example", model: "GX-1" });
  store.upsertPart({ id: "p1", name: "Air filter", manufacturerPartNumber: "AF-1" });

  assert.throws(
    () => store.addCompatibility({ machineModelId: "m1", partId: "p1", evidenceSourceId: "missing" }),
    /FOREIGN KEY constraint failed/
  );
  store.close();
});

test("compatible part lookup returns its supporting evidence", () => {
  const store = new KnowledgeStore();
  store.upsertEvidence({
    id: "manual-1",
    authority: "manufacturer",
    title: "GX-1 Parts Manual",
    uri: "internal://manuals/gx-1",
    observedAt: "2026-09-30T00:00:00.000Z",
  });
  store.upsertMachineModel({ id: "m1", brand: "Example", model: "GX-1" });
  store.upsertPart({
    id: "p1",
    name: "Air filter",
    manufacturerPartNumber: "AF-1",
    aliases: ["filter element"],
  });
  store.addCompatibility({
    machineModelId: "m1",
    partId: "p1",
    relationship: "service_part",
    evidenceSourceId: "manual-1",
  });

  const rows = store.compatibleParts("m1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].manufacturer_part_number, "AF-1");
  assert.equal(rows[0].authority, "manufacturer");
  assert.equal(rows[0].evidence_source_id, "manual-1");
  store.close();
});
