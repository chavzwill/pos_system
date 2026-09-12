'use strict';
const express=require('express');
const router=express.Router();
const base=require('./inventory-adjustment-hardening-base');
router.use(base);
router.use(require('./product-stock-authority'));
module.exports=router;
module.exports.ensureAdjustmentControl=base.ensureAdjustmentControl;
