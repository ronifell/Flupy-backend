const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE, 10) || 10 * 1024 * 1024; // 10MB

/**
 * Storage configuration – saves files with unique names
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', UPLOAD_DIR));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${uuidv4()}${ext}`;
    cb(null, name);
  },
});

/**
 * Filter allowed file types
 */
function fileFilter(req, file, cb) {
  const allowedMimes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} is not allowed`), false);
  }
}

/** Upload a single file */
const uploadSingle = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } }).single('file');

/** Upload multiple files (max 5) */
const uploadMultiple = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } }).array('files', 5);

/** Upload multiple photos for orders (max 10) */
const uploadPhotos = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } }).array('photos', 10);

/**
 * Wrapper that returns a proper JSON error on multer failure
 */
function handleUpload(uploadFn) {
  return (req, res, next) => {
    uploadFn(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  };
}

module.exports = {
  uploadSingle: handleUpload(uploadSingle),
  uploadMultiple: handleUpload(uploadMultiple),
  uploadPhotos: handleUpload(uploadPhotos),
};
