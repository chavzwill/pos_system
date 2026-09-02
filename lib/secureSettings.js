'use strict';

const crypto = require('crypto');

const ENCRYPTED_PREFIX = 'enc:v1:';
const SECRET_SETTING_KEYS = new Set([
  'email_smtp_pass',
  'repair_notify_sms_webhook_token',
  'repair_notify_whatsapp_webhook_token',
  'woo_consumer_key',
  'woo_consumer_secret',
  'woocommerce_consumer_key',
  'woocommerce_consumer_secret',
  'woocommerce_webhook_secret',
  'stripe_secret_key',
  'stripe_webhook_secret',
  'twilio_auth_token',
  'whatsapp_access_token',
  'openai_api_key',
]);

function isSecretSetting(key) {
  return SECRET_SETTING_KEYS.has(String(key || ''));
}

function isEncryptedSettingValue(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

function decodeKey(raw = process.env.POS_SETTINGS_ENCRYPTION_KEY) {
  const source = String(raw || '').trim();
  if (!source) return null;
  let bytes = null;
  if (/^[a-f0-9]{64}$/i.test(source)) bytes = Buffer.from(source, 'hex');
  else {
    try { bytes = Buffer.from(source, 'base64'); } catch (_) { bytes = null; }
  }
  if (!bytes || bytes.length !== 32) {
    throw new Error('POS_SETTINGS_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or 64 hex characters).');
  }
  return bytes;
}

function encryptionKey({ required = false } = {}) {
  const key = decodeKey();
  if (!key && required) {
    throw new Error('POS_SETTINGS_ENCRYPTION_KEY is required to protect configured integration secrets.');
  }
  return key;
}

function protectSettingValue(key, value) {
  const normalized = value == null ? '' : String(value);
  if (!isSecretSetting(key) || normalized === '') return normalized;
  const keyBytes = encryptionKey({ required: process.env.NODE_ENV === 'production' || !!process.env.POS_SETTINGS_ENCRYPTION_KEY });
  if (!keyBytes) return normalized; // Development compatibility only; production never falls back to plaintext.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
  cipher.setAAD(Buffer.from(`pos-settings:v1:${key}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function revealSettingValue(key, stored) {
  if (stored == null) return stored;
  const value = String(stored);
  if (!isSecretSetting(key) || value === '' || !isEncryptedSettingValue(value)) return value;
  const keyBytes = encryptionKey({ required: true });
  const parts = value.slice(ENCRYPTED_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error(`Protected setting ${key} has an invalid encrypted envelope.`);
  try {
    const [ivRaw, tagRaw, ciphertextRaw] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, Buffer.from(ivRaw, 'base64url'));
    decipher.setAAD(Buffer.from(`pos-settings:v1:${key}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (_) {
    throw new Error(`Unable to decrypt protected setting ${key}; verify POS_SETTINGS_ENCRYPTION_KEY.`);
  }
}

function revealSettingsRows(rows) {
  const out = {};
  for (const row of rows || []) out[row.key] = revealSettingValue(row.key, row.value);
  return out;
}

function secretValuesEqual(key, stored, proposed) {
  const next = proposed == null ? '' : String(proposed);
  if (!isSecretSetting(key)) return String(stored ?? '') === next;
  return String(revealSettingValue(key, stored) ?? '') === next;
}

module.exports = {
  ENCRYPTED_PREFIX,
  SECRET_SETTING_KEYS,
  isSecretSetting,
  isEncryptedSettingValue,
  decodeKey,
  encryptionKey,
  protectSettingValue,
  revealSettingValue,
  revealSettingsRows,
  secretValuesEqual,
};
