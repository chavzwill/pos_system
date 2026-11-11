'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_BRAND, BRAND_KEYS, validateBrandValue, normalizePublicBrand, appManifest } = require('../lib/brand-config');

test('defaults do not expose the original company name', () => {
  assert.equal(DEFAULT_BRAND.store_name, 'Your Business');
  assert.equal(normalizePublicBrand({}).store_name, 'Your Business');
  assert.deepEqual(BRAND_KEYS, ['brand_primary_color','brand_secondary_color','brand_accent_color','brand_theme','brand_font']);
});
test('the palette and appearance choices use strict allowlists', () => {
  assert.equal(validateBrandValue('brand_primary_color','#aB12cD'),'#AB12CD');
  assert.equal(validateBrandValue('brand_primary_color','red'),null);
  assert.equal(validateBrandValue('brand_primary_color','red;url(javascript:bad)'),null);
  assert.equal(validateBrandValue('brand_theme','dark'),'dark');
  assert.equal(validateBrandValue('brand_theme','night'),null);
  assert.equal(validateBrandValue('brand_font','manrope'),'manrope');
  assert.equal(validateBrandValue('brand_font','url(evil)'),null);
  assert.equal(validateBrandValue('store_name','Example'),null);
});
test('public brand never accepts javascript, protocol-relative or backslash logo urls', () => {
  for(const logo of ['javascript:alert(1)','//evil.example/image.png','/logo\\evil.png','data:image/png,xxx']) {
    assert.equal(normalizePublicBrand({company_logo_url:logo}).company_logo_url,'');
  }
  assert.equal(normalizePublicBrand({company_logo_url:'/uploads/branding/logo.png'}).company_logo_url,'/uploads/branding/logo.png');
  assert.equal(normalizePublicBrand({company_logo_url:'https://res.cloudinary.com/example/logo.png'}).company_logo_url,'https://res.cloudinary.com/example/logo.png');
});
test('the generated installation manifest includes buyer name and uploaded logo', () => {
  const brand=normalizePublicBrand({store_name:'Acme Retail',brand_primary_color:'#335599',company_logo_url:'/uploads/branding/acme.png'});
  const result=appManifest(brand);
  assert.equal(result.short_name,'Acme Retail');
  assert.equal(result.name,'Acme Retail POS');
  assert.equal(result.theme_color,'#335599');
  assert.equal(result.icons[0].src,'/uploads/branding/acme.png');
  assert.equal(result.icons[0].type,'image/png');
  assert.equal(result.icons[1].src,'/icons/app-192.png');
});
test('invalid saved branding is ignored rather than injected into CSS or manifest',()=>{
  const brand=normalizePublicBrand({store_name:'  ',brand_primary_color:'red',brand_theme:'invalid',brand_font:'bad',company_logo_url:'javascript:alert(1)'});
  assert.equal(brand.brand_primary_color,DEFAULT_BRAND.brand_primary_color);
  assert.equal(brand.brand_theme,DEFAULT_BRAND.brand_theme);
  assert.equal(brand.brand_font,DEFAULT_BRAND.brand_font);
  assert.equal(brand.company_logo_url,'');
  assert.equal(appManifest(brand).icons[0].src,'/icons/app-192.png');
});
