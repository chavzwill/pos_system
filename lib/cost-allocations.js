'use strict';
const { db } = require('../database');

const TYPES = new Set(['rental_asset','vehicle','equipment','building','branch','department','project','work_order','general_overhead']);

async function ensureCostAllocationSchema() {
  await db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS cost_objects(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_type TEXT NOT NULL,
      code TEXT,
      name TEXT NOT NULL,
      branch_id INTEGER REFERENCES branches(id),
      department TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(object_type,code)
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS cost_allocations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_line_id TEXT,
      target_type TEXT NOT NULL,
      target_id TEXT,
      target_label TEXT,
      allocation_amount REAL NOT NULL DEFAULT 0,
      allocation_quantity REAL,
      allocation_percent REAL,
      purpose TEXT,
      expense_category TEXT,
      valuation_status TEXT NOT NULL DEFAULT 'declared',
      created_by INTEGER REFERENCES employees(id),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_cost_alloc_source ON cost_allocations(source_type,source_id,source_line_id)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_cost_alloc_target ON cost_allocations(target_type,target_id,created_at)'}
  ],'write');
}

function normalizeAllocations(allocations, lineAmount) {
  const rows = Array.isArray(allocations) ? allocations : [];
  if (!rows.length) return [];
  let total = 0;
  const normalized = rows.map(a => {
    if (!TYPES.has(a.target_type)) throw new Error('Invalid cost allocation target type');
    const amount = Number(a.allocation_amount ?? (lineAmount * Number(a.allocation_percent || 0) / 100));
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid cost allocation amount');
    total += amount;
    return {
      target_type:a.target_type,target_id:a.target_id == null ? null : String(a.target_id),
      target_label:a.target_label || null,allocation_amount:Number(amount.toFixed(2)),
      allocation_quantity:a.allocation_quantity == null ? null : Number(a.allocation_quantity),
      allocation_percent:a.allocation_percent == null ? null : Number(a.allocation_percent),
      purpose:a.purpose || null,expense_category:a.expense_category || null,
      valuation_status:a.valuation_status || 'declared'
    };
  });
  if (Math.abs(total - Number(lineAmount || 0)) > 0.01) throw new Error('Cost allocations must equal the full line amount');
  return normalized;
}

async function insertAllocations(executor, {sourceType,sourceId,sourceLineId,allocations,createdBy}) {
  for (const a of allocations) {
    await executor.execute({sql:`INSERT INTO cost_allocations(
      source_type,source_id,source_line_id,target_type,target_id,target_label,
      allocation_amount,allocation_quantity,allocation_percent,purpose,expense_category,valuation_status,created_by
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[
      sourceType,String(sourceId),sourceLineId == null ? null : String(sourceLineId),
      a.target_type,a.target_id,a.target_label,a.allocation_amount,a.allocation_quantity,
      a.allocation_percent,a.purpose,a.expense_category,a.valuation_status,createdBy || null
    ]});
  }
}

async function allocationsForSource(sourceType, sourceId) {
  await ensureCostAllocationSchema();
  const {rows}=await db.execute({sql:'SELECT * FROM cost_allocations WHERE source_type=? AND source_id=? ORDER BY id',args:[sourceType,String(sourceId)]});
  return rows;
}

module.exports={ TYPES, ensureCostAllocationSchema, normalizeAllocations, insertAllocations, allocationsForSource };
