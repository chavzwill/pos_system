export const AUTHORITY = Object.freeze({
  POS: "pos",
  SPENDOS: "spendos",
  SMARTCOMMERCE: "smartcommerce",
  MANUFACTURER: "manufacturer",
  INTERNAL_DOCUMENT: "internal_document",
  AI_DERIVED: "ai_derived",
});

export const FACT_KIND = Object.freeze({
  VERIFIED: "verified",
  CALCULATED: "calculated",
  INFERRED: "inferred",
  UNKNOWN: "unknown",
});

export function requireEmployeeContext(context) {
  if (!context || typeof context !== "object") throw new Error("EMPLOYEE_CONTEXT_REQUIRED");
  if (!context.employeeId) throw new Error("EMPLOYEE_ID_REQUIRED");
  if (!context.branchId) throw new Error("BRANCH_CONTEXT_REQUIRED");
  if (!Array.isArray(context.permissions)) throw new Error("PERMISSIONS_REQUIRED");
  return context;
}

export function assertReadPermission(context, permission) {
  requireEmployeeContext(context);
  if (!context.permissions.includes(permission)) {
    const error = new Error("TT_AI_PERMISSION_DENIED");
    error.code = "TT_AI_PERMISSION_DENIED";
    error.permission = permission;
    throw error;
  }
}

export function classifyAnswer({ evidence = [], calculation = false, inference = false } = {}) {
  if (!Array.isArray(evidence) || evidence.length === 0) return FACT_KIND.UNKNOWN;
  if (inference) return FACT_KIND.INFERRED;
  if (calculation) return FACT_KIND.CALCULATED;
  return FACT_KIND.VERIFIED;
}

export function assertEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") throw new Error("EVIDENCE_REQUIRED");
  if (!evidence.sourceId) throw new Error("EVIDENCE_SOURCE_ID_REQUIRED");
  if (!Object.values(AUTHORITY).includes(evidence.authority)) throw new Error("EVIDENCE_AUTHORITY_INVALID");
  if (!evidence.observedAt) throw new Error("EVIDENCE_TIMESTAMP_REQUIRED");
  return evidence;
}
