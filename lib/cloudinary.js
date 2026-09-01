const { v2: cloudinary } = require('cloudinary');
const { db } = require('../database');
const { Readable } = require('stream');

const PRIVATE_EVIDENCE_FOLDERS = [
  'pos-system/customer-ids',
  'pos-system/rental-signatures',
  'pos-system/po-attachments',
  'pos-system/rental-po-attachments',
];

function isPrivateEvidenceUpload(options = {}) {
  const folder = String(options.folder || '').replace(/\/+$/, '');
  return PRIVATE_EVIDENCE_FOLDERS.some(prefix => folder === prefix || folder.startsWith(`${prefix}/`));
}

async function configure() {
  const keys = ['cloudinary_cloud_name', 'cloudinary_api_key', 'cloudinary_api_secret'];
  const { rows } = await db.execute({
    sql: `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`,
    args: keys,
  });
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  if (!s.cloudinary_cloud_name || !s.cloudinary_api_key || !s.cloudinary_api_secret) return false;
  cloudinary.config({
    cloud_name: s.cloudinary_cloud_name,
    api_key: s.cloudinary_api_key,
    api_secret: s.cloudinary_api_secret,
  });
  return true;
}

async function cloudUpload(buffer, options = {}) {
  // Identity documents, signatures and commercial source evidence must not
  // become bearer-accessible public cloud URLs. Their existing route callers
  // already have local-disk fallbacks, which are protected by employee auth.
  if (isPrivateEvidenceUpload(options)) return null;
  if (!await configure()) return null;
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) reject(err); else resolve(result);
    });
    Readable.from(buffer).pipe(stream);
  });
}

async function cloudDestroy(url, resourceType = 'image') {
  if (!await configure()) return;
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
  if (!match) return;
  await cloudinary.uploader.destroy(match[1], { resource_type: resourceType }).catch(() => {});
}

module.exports = { cloudUpload, cloudDestroy, isPrivateEvidenceUpload, PRIVATE_EVIDENCE_FOLDERS };
