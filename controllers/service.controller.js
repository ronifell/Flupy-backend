const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { t } = require('../i18n');

/**
 * Get all service categories (admin/manage)
 * Can filter by country
 */
async function getAllServices(req, res) {
  const { country } = req.query;
  
  let query = 'SELECT * FROM service_categories WHERE 1=1';
  const params = [];
  
  if (country) {
    query += ' AND country = ?';
    params.push(country);
  }
  
  query += ' ORDER BY country, sort_order';
  
  const services = await db.query(query, params);
  res.json({ services });
}

/**
 * Get a single service category by ID
 */
async function getServiceById(req, res) {
  const { id } = req.params;
  
  const [service] = await db.query(
    'SELECT * FROM service_categories WHERE id = ?',
    [id]
  );
  
  if (!service) {
    throw new AppError('Service category not found', 404);
  }
  
  res.json({ service });
}

/**
 * Create a new service category
 */
async function createService(req, res) {
  const { name, slug, description, icon_url, country, sort_order } = req.body;
  
  // Validate required fields
  if (!name || !slug || !country) {
    throw new AppError('Name, slug, and country are required', 400);
  }
  
  // Check if service with same name/slug already exists for this country
  const existing = await db.query(
    'SELECT id FROM service_categories WHERE (name = ? OR slug = ?) AND country = ?',
    [name, slug, country]
  );
  
  if (existing.length > 0) {
    throw new AppError('Service category with this name or slug already exists for this country', 409);
  }
  
  const result = await db.query(
    `INSERT INTO service_categories (name, slug, description, icon_url, country, sort_order, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [name, slug, description || null, icon_url || null, country, sort_order || 0]
  );
  
  const [service] = await db.query(
    'SELECT * FROM service_categories WHERE id = ?',
    [result.insertId]
  );
  
  const language = req.language || 'en';
  res.status(201).json({
    message: t('messages.serviceCreated', {}, language) || 'Service category created successfully',
    service,
  });
}

/**
 * Update a service category
 */
async function updateService(req, res) {
  const { id } = req.params;
  const { name, slug, description, icon_url, country, sort_order, is_active } = req.body;
  
  // Check if service exists
  const [existing] = await db.query(
    'SELECT * FROM service_categories WHERE id = ?',
    [id]
  );
  
  if (!existing) {
    throw new AppError('Service category not found', 404);
  }
  
  // If name, slug, or country is being changed, check for duplicates
  if (name || slug || country) {
    const checkName = name || existing.name;
    const checkSlug = slug || existing.slug;
    const checkCountry = country || existing.country;
    
    const duplicate = await db.query(
      'SELECT id FROM service_categories WHERE id != ? AND ((name = ? OR slug = ?) AND country = ?)',
      [id, checkName, checkSlug, checkCountry]
    );
    
    if (duplicate.length > 0) {
      throw new AppError('Service category with this name or slug already exists for this country', 409);
    }
  }
  
  // Build update query
  const fields = [];
  const values = [];
  
  if (name !== undefined) { fields.push('name = ?'); values.push(name); }
  if (slug !== undefined) { fields.push('slug = ?'); values.push(slug); }
  if (description !== undefined) { fields.push('description = ?'); values.push(description); }
  if (icon_url !== undefined) { fields.push('icon_url = ?'); values.push(icon_url); }
  if (country !== undefined) { fields.push('country = ?'); values.push(country); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(sort_order); }
  if (is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active); }
  
  if (fields.length === 0) {
    throw new AppError('No fields to update', 400);
  }
  
  values.push(id);
  await db.query(
    `UPDATE service_categories SET ${fields.join(', ')} WHERE id = ?`,
    values
  );
  
  const [service] = await db.query(
    'SELECT * FROM service_categories WHERE id = ?',
    [id]
  );
  
  const language = req.language || 'en';
  res.json({
    message: t('messages.serviceUpdated', {}, language) || 'Service category updated successfully',
    service,
  });
}

/**
 * Delete a service category
 */
async function deleteService(req, res) {
  const { id } = req.params;
  
  // Check if service exists
  const [existing] = await db.query(
    'SELECT * FROM service_categories WHERE id = ?',
    [id]
  );
  
  if (!existing) {
    throw new AppError('Service category not found', 404);
  }
  
  // Check if service is being used by any providers or orders
  const [providers] = await db.query(
    'SELECT COUNT(*) as count FROM provider_services WHERE service_id = ?',
    [id]
  );
  
  const [orders] = await db.query(
    'SELECT COUNT(*) as count FROM service_orders WHERE service_id = ?',
    [id]
  );
  
  if (providers[0].count > 0 || orders[0].count > 0) {
    // Instead of deleting, deactivate
    await db.query(
      'UPDATE service_categories SET is_active = 0 WHERE id = ?',
      [id]
    );
    const language = req.language || 'en';
    return res.json({
      message: t('messages.serviceDeactivated', {}, language) || 'Service category deactivated (cannot delete as it is in use)',
    });
  }
  
  // Safe to delete
  await db.query('DELETE FROM service_categories WHERE id = ?', [id]);
  
  const language = req.language || 'en';
  res.json({
    message: t('messages.serviceDeleted', {}, language) || 'Service category deleted successfully',
  });
}

module.exports = {
  getAllServices,
  getServiceById,
  createService,
  updateService,
  deleteService,
};
