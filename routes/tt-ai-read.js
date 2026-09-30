const express = require('express');
const router = express.Router();
const { requireAuth, requireAnyPermission, can } = require('../lib/permissions');
const {
  PRODUCT_READ_PERMISSIONS,
  MACHINE_READ_PERMISSIONS,
  resolveBranch,
  searchProducts,
  searchRentalAssets,
  readRentalAsset,
} = require('../lib/tt-ai-read-tools');
const { queryTTAI } = require('../lib/tt-ai-client');

function rejectMachineCredential(req, res, next) {
  if (req.apiKey) return res.status(403).json({
    error: 'TT AI employee context requires an authenticated staff session',
    code: 'TT_AI_STAFF_SESSION_REQUIRED',
  });
  next();
}

function statusFor(error) {
  return Number(error?.status) || 500;
}

function sendError(res, error, fallback) {
  const status = statusFor(error);
  if (status >= 500) console.error('tt_ai_gateway_error', {
    code: error?.code || 'unknown',
    message: String(error?.message || error).slice(0, 300),
  });
  return res.status(status).json({
    error: status >= 500 ? fallback : error.message,
    code: error?.code || 'TT_AI_REQUEST_FAILED',
  });
}

router.use(rejectMachineCredential);

router.get('/context', requireAuth, (req, res) => {
  const permissions = req.employee?.permissions || {};
  let branchId = null;
  try { branchId = resolveBranch(req.employee, req.query.branch_id); } catch (_) {}
  res.json({
    employee_id: req.employee.id,
    branch_id: branchId,
    security_group: req.employee.security_group_name || null,
    capabilities: {
      products: PRODUCT_READ_PERMISSIONS.some(key => can(permissions, key)),
      rental_machines: MACHINE_READ_PERMISSIONS.some(key => can(permissions, key)),
      rental_assets: MACHINE_READ_PERMISSIONS.some(key => can(permissions, key)),
      cost_visibility: can(permissions, 'purchasing') || can(permissions, 'reports_financial'),
      multi_branch: can(permissions, 'multi_branch_access'),
      query: Boolean(process.env.TT_AI_SERVICE_URL && process.env.TT_AI_SHARED_SECRET),
      writes: false,
    },
  });
});

router.get(
  '/products/search',
  requireAnyPermission(...PRODUCT_READ_PERMISSIONS),
  async (req, res) => {
    try {
      res.json(await searchProducts({
        employee: req.employee,
        branchId: req.query.branch_id,
        query: req.query.q,
        limit: req.query.limit,
      }));
    } catch (error) {
      sendError(res, error, 'Unable to read product data for TT AI');
    }
  }
);

router.get(
  '/rental-machines/search',
  requireAnyPermission(...MACHINE_READ_PERMISSIONS),
  async (req, res) => {
    try {
      res.json(await searchProducts({
        employee: req.employee,
        branchId: req.query.branch_id,
        query: req.query.q,
        limit: req.query.limit,
        rentalsOnly: true,
      }));
    } catch (error) {
      sendError(res, error, 'Unable to read rental product data for TT AI');
    }
  }
);

router.get(
  '/rental-assets/search',
  requireAnyPermission(...MACHINE_READ_PERMISSIONS),
  async (req, res) => {
    try {
      res.json(await searchRentalAssets({
        employee: req.employee,
        branchId: req.query.branch_id,
        query: req.query.q,
        limit: req.query.limit,
      }));
    } catch (error) {
      sendError(res, error, 'Unable to read rental asset data for TT AI');
    }
  }
);

router.get(
  '/rental-assets/:identifier',
  requireAnyPermission(...MACHINE_READ_PERMISSIONS),
  async (req, res) => {
    try {
      res.json(await readRentalAsset({
        employee: req.employee,
        branchId: req.query.branch_id,
        identifier: req.params.identifier,
      }));
    } catch (error) {
      sendError(res, error, 'Unable to read rental asset data for TT AI');
    }
  }
);

router.post('/query', requireAuth, async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (message.length < 2 || message.length > 2000) {
    return res.status(400).json({ error: 'Question must contain between 2 and 2000 characters', code: 'TT_AI_QUESTION_INVALID' });
  }
  try {
    const result = await queryTTAI({
      employee: req.employee,
      message,
      requestId: req.requestId || undefined,
    });
    res.json(result);
  } catch (error) {
    sendError(res, error, 'TT AI is temporarily unavailable');
  }
});

module.exports = router;
