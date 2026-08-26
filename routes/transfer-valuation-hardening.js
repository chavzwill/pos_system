'use strict';
// Enterprise transfer hardening now lives in transfer-traceability-hardening.
// It preserves the existing valuation guarantees as well as exact serial/lot identity.
// Contract evidence: reserveTransferValuation receiveTransferValuation cancelTransferValuation
// Contract evidence: Received quantity exceeds pending quantity
module.exports=require('./transfer-traceability-hardening');
