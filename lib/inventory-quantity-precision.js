'use strict';
const {getProfile}=require('./unit-of-measure');
function roundTo(n,p){const m=10**p;return Math.round((Number(n)+Number.EPSILON)*m)/m;}
async function normalizeInventoryQuantity(executor,productId,value,{allowZero=false,label='Quantity'}={}){
  const profile=await getProfile(executor,productId);const precision=Math.max(0,Math.min(6,Number(profile?.base_precision||0)));
  const n=Number(value);if(!Number.isFinite(n))throw new Error(`${label} must be numeric`);
  const rounded=roundTo(n,precision),epsilon=10**(-(precision+4));
  if(Math.abs(n-rounded)>epsilon)throw new Error(`${label} exceeds the configured ${precision}-decimal precision for ${profile.base_uom}`);
  if(allowZero?rounded<0:rounded<=0)throw new Error(`${label} must be ${allowZero?'zero or greater':'greater than zero'}`);
  return {quantity:rounded,precision,base_uom:profile.base_uom,profile};
}
async function normalizeSignedInventoryQuantity(executor,productId,value,{allowZero=false,label='Quantity'}={}){
  const profile=await getProfile(executor,productId);const precision=Math.max(0,Math.min(6,Number(profile?.base_precision||0)));
  const n=Number(value);if(!Number.isFinite(n))throw new Error(`${label} must be numeric`);
  const rounded=roundTo(n,precision),epsilon=10**(-(precision+4));
  if(Math.abs(n-rounded)>epsilon)throw new Error(`${label} exceeds the configured ${precision}-decimal precision for ${profile.base_uom}`);
  if(!allowZero&&rounded===0)throw new Error(`${label} must be non-zero`);
  return {quantity:rounded,precision,base_uom:profile.base_uom,profile};
}
module.exports={normalizeInventoryQuantity,normalizeSignedInventoryQuantity,roundTo};
