const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requireAnyPermission } = require('../lib/permissions');

const cleanName=v=>String(v||'').trim();
const publicError=(res,status,error,code)=>res.status(status).json({error,code});

router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT c.*, COUNT(p.id) as product_count FROM categories c LEFT JOIN products p ON p.category_id = c.id AND p.active = 1 GROUP BY c.id ORDER BY c.name', args: [] });
    res.json(rows);
  } catch(e) {
    console.error('category_list_error',{message:e?.message||'unknown'});
    publicError(res,500,'Unable to load categories right now.','CATEGORY_LIST_UNAVAILABLE');
  }
});

router.post('/', requireAnyPermission('settings', 'inventory'), async (req, res) => {
  const name=cleanName(req.body?.name), description=String(req.body?.description||'').trim()||null;
  if (!name) return publicError(res,400,'Category name is required.','CATEGORY_NAME_REQUIRED');
  try {
    const result=await db.execute({sql:`INSERT INTO categories (name,description)
      SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM categories WHERE lower(trim(name))=lower(trim(?)))`,args:[name,description,name]});
    if(Number(result.rowsAffected||0)!==1)return publicError(res,409,'A category with this name already exists.','CATEGORY_NAME_EXISTS');
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM categories WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch(e) {
    console.error('category_create_error',{message:e?.message||'unknown'});
    publicError(res,500,'Unable to create this category right now.','CATEGORY_CREATE_UNAVAILABLE');
  }
});

router.put('/:id', requireAnyPermission('settings', 'inventory'), async (req, res) => {
  const name=cleanName(req.body?.name), description=String(req.body?.description||'').trim()||null, id=Number(req.params.id);
  if(!Number.isInteger(id)||id<=0)return publicError(res,400,'A valid category is required.','CATEGORY_ID_INVALID');
  if(!name)return publicError(res,400,'Category name is required.','CATEGORY_NAME_REQUIRED');
  try {
    const result=await db.execute({sql:`UPDATE categories SET name=?,description=? WHERE id=?
      AND NOT EXISTS(SELECT 1 FROM categories other WHERE other.id<>? AND lower(trim(other.name))=lower(trim(?)))`,args:[name,description,id,id,name]});
    if(Number(result.rowsAffected||0)!==1){
      const {rows:[existing]}=await db.execute({sql:'SELECT id FROM categories WHERE id=?',args:[id]});
      if(!existing)return publicError(res,404,'Category not found.','CATEGORY_NOT_FOUND');
      return publicError(res,409,'A category with this name already exists.','CATEGORY_NAME_EXISTS');
    }
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM categories WHERE id = ?', args: [id] });
    res.json(row);
  } catch(e) {
    console.error('category_update_error',{message:e?.message||'unknown'});
    publicError(res,500,'Unable to update this category right now.','CATEGORY_UPDATE_UNAVAILABLE');
  }
});

router.delete('/:id', requireAnyPermission('settings', 'inventory'), async (req, res) => {
  try {
    const { rows: [inUse] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM products WHERE category_id = ?', args: [req.params.id] });
    if (Number(inUse?.c||0) > 0) return publicError(res,409,'Move the products in this category before deleting it.','CATEGORY_IN_USE');
    const result=await db.execute({ sql: 'DELETE FROM categories WHERE id = ?', args: [req.params.id] });
    if(Number(result.rowsAffected||0)!==1)return publicError(res,404,'Category not found.','CATEGORY_NOT_FOUND');
    res.json({ success: true });
  } catch(e) {
    console.error('category_delete_error',{message:e?.message||'unknown'});
    publicError(res,500,'Unable to delete this category right now.','CATEGORY_DELETE_UNAVAILABLE');
  }
});

module.exports = router;
