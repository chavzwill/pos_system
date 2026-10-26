'use strict';
const express=require('express');
const router=express.Router();
const capture=require('../lib/supplier-invoice-capture');
const {requireAnyPermission}=require('../lib/permissions');
const {db}=require('../database');
const {ensureReceiptInvoiceLinkSchema}=require('./purchase-receipt-invoice-links');
function report(res,e){const conflict=/UNIQUE|SQLITE_CONSTRAINT/.test(String(e.message));const status=e.status||(conflict?409:500);if(status>=500)console.error('invoice_capture_failed',e);return res.status(status).json({error:status>=500?'Invoice capture failed. Please retry.':conflict?'Supplier invoice identity or receipt evidence already exists.':e.message});}
async function ready(req,res,next){try{if(req.path!=='/invoices')capture.assertStaff(req);await ensureReceiptInvoiceLinkSchema();await capture.ensureSchema();next();}catch(e){report(res,e);}}
const access=requireAnyPermission('purchasing_receive','reports_financial');
router.get('/captured-invoices',access,ready,async(req,res)=>{try{res.json(await capture.list(db,req,capture.id(req.query.purchase_order_id)));}catch(e){report(res,e);}});
router.post('/captured-invoices',access,ready,async(req,res)=>{try{const saved=await capture.capture(req);res.status(saved.replayed?200:201).json(saved);}catch(e){report(res,e);}});
router.post('/captured-invoices/:id/allocate',access,ready,async(req,res)=>{try{const saved=await capture.allocate(req);res.status(saved.replayed?200:201).json(saved);}catch(e){report(res,e);}});
router.post('/captured-invoices/:id/void',access,ready,async(req,res)=>{try{res.json(await capture.voidCapture(req));}catch(e){report(res,e);}});
router.post('/invoices',ready,async(req,res,next)=>{try{const replay=await capture.preparePosting(req);if(replay)return res.json(replay);next();}catch(e){report(res,e);}});
module.exports=router;
