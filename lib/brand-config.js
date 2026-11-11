'use strict';

const DEFAULT_BRAND = Object.freeze({
  store_name: 'Your Business',
  company_logo_url: '',
  brand_primary_color: '#0B7A3E',
  brand_secondary_color: '#075C31',
  brand_accent_color: '#F2D11F',
  brand_theme: 'light',
  brand_font: 'inter'
});
const BRAND_KEYS = Object.freeze(['brand_primary_color', 'brand_secondary_color', 'brand_accent_color', 'brand_theme', 'brand_font']);
const COLOR_KEYS = new Set(['brand_primary_color', 'brand_secondary_color', 'brand_accent_color']);
const THEME_CHOICES = new Set(['light', 'dark', 'system']);
const FONT_CHOICES = new Set(['inter', 'manrope', 'system']);
const HEX_COLOR = /^#[\da-fA-F]{6}$/;

function validateBrandValue(key, value) {
  if (!BRAND_KEYS.includes(key)) return null;
  const input = String(value ?? '').trim();
  if (COLOR_KEYS.has(key)) return HEX_COLOR.test(input) ? input.toUpperCase() : null;
  if (key === 'brand_theme') return THEME_CHOICES.has(input) ? input : null;
  if (key === 'brand_font') return FONT_CHOICES.has(input) ? input : null;
  return null;
}

function normalizePublicBrand(values = {}) {
  const result = { ...DEFAULT_BRAND };
  if (typeof values.store_name === 'string' && values.store_name.trim()) result.store_name = values.store_name.trim().slice(0, 120);
  const logo = String(values.company_logo_url || '');
  if ((logo.startsWith('/') && !logo.startsWith('//') && !logo.includes('\\')) || /^https:\/\//i.test(logo)) result.company_logo_url = logo;
  for (const key of BRAND_KEYS) {
    const accepted = validateBrandValue(key, values[key]);
    if (accepted !== null) result[key] = accepted;
  }
  return result;
}

function appManifest(brand) {
  const name = brand.store_name.slice(0, 45);
  const fallbackIcons = [
    { src: '/icons/app-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/app-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/app-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ];
  const logo = brand.company_logo_url;
  const cleanPath = logo.split(/[?#]/)[0].toLowerCase();
  const mime = /\.png$/.test(cleanPath) ? 'image/png' : /\.jpe?g$/.test(cleanPath) ? 'image/jpeg' : /\.webp$/.test(cleanPath) ? 'image/webp' : '';
  return {
    id: '/', name: name + ' POS', short_name: name.slice(0, 24),
    description: 'Sales, stock, purchasing and business operations',
    lang: 'en', start_url: '/', scope: '/', display: 'standalone',
    background_color: '#F8F9F7', theme_color: brand.brand_primary_color,
    icons: mime && logo ? [{ src: logo, sizes: 'any', type: mime, purpose: 'any' }, ...fallbackIcons] : fallbackIcons
  };
}

module.exports = { DEFAULT_BRAND, BRAND_KEYS, validateBrandValue, normalizePublicBrand, appManifest };
