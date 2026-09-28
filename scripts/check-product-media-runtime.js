'use strict';
const assert=require('assert');
const {sanitizeSkuForFilename,productIndex,planBulkImages}=require('../lib/product-media');
assert.equal(sanitizeSkuForFilename(' ABC/123 '),'ABC_123');
assert.equal(sanitizeSkuForFilename('A B:C'),'A_B_C');
const products=[
 {id:1,sku:'ABC/123',image_path:null},
 {id:2,sku:'HAS-IMG',image_path:'/uploads/products/HAS-IMG.jpg'},
 {id:3,sku:'OLD-1',image_path:null,consolidated_into_product_id:9},
 {id:4,sku:'A/B',image_path:null},
 {id:5,sku:'A_B',image_path:null}
];
const index=productIndex(products);assert.equal(index.get('abc_123').length,1);assert.equal(index.get('a_b').length,2);
let plan=planBulkImages(products,[{name:'ABC_123.jpg'},{name:'HAS-IMG.png'},{name:'MISS.jpg'},{name:'OLD-1.webp'},{name:'A_B.jpg'}]);
assert.deepEqual(plan.map(x=>x.status),['add','existing_image_preserved','unmatched','consolidated','ambiguous']);
plan=planBulkImages(products,[{name:'HAS-IMG.png'}],{replaceExisting:true});assert.equal(plan[0].status,'replace');
console.log('Product Media runtime certification passed.');