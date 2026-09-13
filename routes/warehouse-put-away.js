'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureInventoryStockStatus}=require('../lib/inventory-stock-status');

router.use(requirePermission('warehouse'));

module.exports=router;
