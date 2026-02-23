/**
 * Build file URL from a request object and filename
 */
function buildFileUrl(req, filename) {
  const protocol = req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}/uploads/${filename}`;
}

/**
 * Parse pagination params with defaults
 */
function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * Remove undefined keys from an object
 */
function cleanObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * Generate a random 6-digit code
 */
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

module.exports = { buildFileUrl, parsePagination, cleanObject, generateCode };
