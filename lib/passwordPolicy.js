'use strict';

const COMMON_PASSWORDS = new Set([
  '123456','12345678','password','password1','admin','admin123','letmein','qwerty','welcome','totaltools',
]);

function strongPassword(value) {
  const password = String(value || '');
  return password.length >= 12
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password)
    && !COMMON_PASSWORDS.has(password.toLowerCase());
}

function passwordPolicyError(value) {
  if (strongPassword(value)) return null;
  return 'Password must be at least 12 characters and include lowercase, uppercase, a number, and a symbol.';
}

module.exports = { strongPassword, passwordPolicyError };
