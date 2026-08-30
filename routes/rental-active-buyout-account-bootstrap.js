'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {ensureLedger}=require('../lib/accounting-posting');
let readyPromise=null;
async function ensureBuyoutAccounts(){if(readyPromise)return readyPromise;readyPromise=(async()=>{await ensureLedger();await db.execute({sql:`INSERT OR IGNORE INTO ledger_accounts(code,name,account_type,normal_balance,system_account) VALUES('2200','Customer Deposits','liability','credit',1)`,args:[]});})().catch(e=>{readyPromise=null;throw e;});return readyPromise;}
router.use(async(req,res,next)=>{try{await ensureBuyoutAccounts();next();}catch(e){res.status(500).json({error:'Active rental buyout accounting bootstrap failed',detail:e.message});}});
module.exports=router;
module.exports.ensureBuyoutAccounts=ensureBuyoutAccounts;
