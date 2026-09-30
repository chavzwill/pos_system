import { DatabaseSync } from "node:sqlite";

export class KnowledgeStore {
  constructor({ path = ":memory:" } = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.#init();
  }

  #init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evidence_sources (
        id TEXT PRIMARY KEY,
        authority TEXT NOT NULL,
        title TEXT NOT NULL,
        uri TEXT,
        observed_at TEXT NOT NULL,
        checksum TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS machine_models (
        id TEXT PRIMARY KEY,
        brand TEXT NOT NULL,
        model TEXT NOT NULL,
        product_id TEXT,
        engine_model TEXT,
        specifications_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS parts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        manufacturer_part_number TEXT,
        specifications_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS part_aliases (
        part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        PRIMARY KEY (part_id, alias)
      );

      CREATE TABLE IF NOT EXISTS compatibility_edges (
        machine_model_id TEXT NOT NULL REFERENCES machine_models(id) ON DELETE CASCADE,
        part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
        relationship TEXT NOT NULL,
        evidence_source_id TEXT NOT NULL REFERENCES evidence_sources(id),
        notes TEXT,
        PRIMARY KEY (machine_model_id, part_id, relationship, evidence_source_id)
      );

      CREATE TABLE IF NOT EXISTS technical_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        fact_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        evidence_source_id TEXT NOT NULL REFERENCES evidence_sources(id),
        UNIQUE(subject_type, subject_id, fact_key, evidence_source_id)
      );
    `);
  }

  upsertEvidence({ id, authority, title, uri = null, observedAt, checksum = null, metadata = {} }) {
    this.db.prepare(`
      INSERT INTO evidence_sources(id,authority,title,uri,observed_at,checksum,metadata_json)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        authority=excluded.authority,
        title=excluded.title,
        uri=excluded.uri,
        observed_at=excluded.observed_at,
        checksum=excluded.checksum,
        metadata_json=excluded.metadata_json
    `).run(id, authority, title, uri, observedAt, checksum, JSON.stringify(metadata));
  }

  upsertMachineModel({ id, brand, model, productId = null, engineModel = null, specifications = {} }) {
    this.db.prepare(`
      INSERT INTO machine_models(id,brand,model,product_id,engine_model,specifications_json)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        brand=excluded.brand,
        model=excluded.model,
        product_id=excluded.product_id,
        engine_model=excluded.engine_model,
        specifications_json=excluded.specifications_json
    `).run(id, brand, model, productId, engineModel, JSON.stringify(specifications));
  }

  upsertPart({ id, name, manufacturerPartNumber = null, specifications = {}, aliases = [] }) {
    this.db.prepare(`
      INSERT INTO parts(id,name,manufacturer_part_number,specifications_json)
      VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        manufacturer_part_number=excluded.manufacturer_part_number,
        specifications_json=excluded.specifications_json
    `).run(id, name, manufacturerPartNumber, JSON.stringify(specifications));

    const insertAlias = this.db.prepare("INSERT OR IGNORE INTO part_aliases(part_id,alias) VALUES(?,?)");
    for (const alias of aliases) insertAlias.run(id, String(alias));
  }

  addCompatibility({ machineModelId, partId, relationship = "compatible", evidenceSourceId, notes = null }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO compatibility_edges(machine_model_id,part_id,relationship,evidence_source_id,notes)
      VALUES(?,?,?,?,?)
    `).run(machineModelId, partId, relationship, evidenceSourceId, notes);
  }

  addFact({ subjectType, subjectId, key, value, evidenceSourceId }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO technical_facts(subject_type,subject_id,fact_key,value_json,evidence_source_id)
      VALUES(?,?,?,?,?)
    `).run(subjectType, subjectId, key, JSON.stringify(value), evidenceSourceId);
  }

  compatibleParts(machineModelId) {
    return this.db.prepare(`
      SELECT p.id,p.name,p.manufacturer_part_number,c.relationship,c.notes,
        e.id AS evidence_source_id,e.authority,e.title,e.uri,e.observed_at
      FROM compatibility_edges c
      JOIN parts p ON p.id=c.part_id
      JOIN evidence_sources e ON e.id=c.evidence_source_id
      WHERE c.machine_model_id=?
      ORDER BY p.name
    `).all(machineModelId);
  }

  close() {
    this.db.close();
  }
}
