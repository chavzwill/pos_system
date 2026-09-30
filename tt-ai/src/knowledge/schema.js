import { assertEvidence } from "../core/policy.js";

const text = (value, field) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field}_REQUIRED`);
  return value.trim();
};

export function productRecord(input) {
  const record = {
    id: text(input?.id, "PRODUCT_ID"),
    name: text(input?.name, "PRODUCT_NAME"),
    sku: input?.sku?.trim() || null,
    barcode: input?.barcode?.trim() || null,
    brand: input?.brand?.trim() || null,
    model: input?.model?.trim() || null,
    categoryIds: Array.isArray(input?.categoryIds) ? [...input.categoryIds] : [],
    specifications: { ...(input?.specifications || {}) },
    applications: Array.isArray(input?.applications) ? [...input.applications] : [],
    accessoryIds: Array.isArray(input?.accessoryIds) ? [...input.accessoryIds] : [],
    substituteProductIds: Array.isArray(input?.substituteProductIds) ? [...input.substituteProductIds] : [],
    evidence: (input?.evidence || []).map(assertEvidence),
  };
  return Object.freeze(record);
}

export function machineModelRecord(input) {
  return Object.freeze({
    id: text(input?.id, "MACHINE_MODEL_ID"),
    brand: text(input?.brand, "MACHINE_BRAND"),
    model: text(input?.model, "MACHINE_MODEL"),
    productId: input?.productId || null,
    engineModel: input?.engineModel || null,
    specifications: { ...(input?.specifications || {}) },
    compatiblePartIds: Array.isArray(input?.compatiblePartIds) ? [...input.compatiblePartIds] : [],
    consumablePartIds: Array.isArray(input?.consumablePartIds) ? [...input.consumablePartIds] : [],
    serviceIntervals: Array.isArray(input?.serviceIntervals) ? [...input.serviceIntervals] : [],
    manualDocumentIds: Array.isArray(input?.manualDocumentIds) ? [...input.manualDocumentIds] : [],
    evidence: (input?.evidence || []).map(assertEvidence),
  });
}

export function assetRecord(input) {
  return Object.freeze({
    id: text(input?.id, "ASSET_ID"),
    machineModelId: text(input?.machineModelId, "ASSET_MACHINE_MODEL_ID"),
    serialNumber: input?.serialNumber || null,
    assetTag: input?.assetTag || null,
    branchId: input?.branchId || null,
    status: input?.status || "unknown",
    serviceHistoryRefs: Array.isArray(input?.serviceHistoryRefs) ? [...input.serviceHistoryRefs] : [],
    repairHistoryRefs: Array.isArray(input?.repairHistoryRefs) ? [...input.repairHistoryRefs] : [],
    evidence: (input?.evidence || []).map(assertEvidence),
  });
}

export function partRecord(input) {
  return Object.freeze({
    id: text(input?.id, "PART_ID"),
    name: text(input?.name, "PART_NAME"),
    manufacturerPartNumber: input?.manufacturerPartNumber || null,
    alternatePartNumbers: Array.isArray(input?.alternatePartNumbers) ? [...input.alternatePartNumbers] : [],
    compatibleMachineModelIds: Array.isArray(input?.compatibleMachineModelIds)
      ? [...input.compatibleMachineModelIds]
      : [],
    specifications: { ...(input?.specifications || {}) },
    evidence: (input?.evidence || []).map(assertEvidence),
  });
}
