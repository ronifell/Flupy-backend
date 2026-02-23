const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { validate, addressRules, idParam } = require('../utils/validators');
const addressController = require('../controllers/address.controller');

router.use(authenticate);

router.get('/', asyncHandler(addressController.getAddresses));
router.post('/', addressRules, validate, asyncHandler(addressController.addAddress));
router.put('/:id', idParam, validate, asyncHandler(addressController.updateAddress));
router.delete('/:id', idParam, validate, asyncHandler(addressController.deleteAddress));

module.exports = router;
