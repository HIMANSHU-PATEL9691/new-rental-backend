const express = require('express');
const itemController = require('../controllers/itemController');
const multer = require('multer');

const router = express.Router();

// Multer configuration for file uploads
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || 
        file.mimetype === 'application/vnd.ms-excel' ||
        file.mimetype === 'text/csv' ||
        file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel (.xlsx, .xls) or CSV files are allowed'));
    }
  }
});

const path = require('path');
const fs = require('fs');

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/items');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e6);
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uniqueSuffix}${ext}`);
  }
});

const imageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

const requireAdmin = require('../middlewares/requireAdmin');

router.get('/', itemController.getItems);


// Admin-only: add/update inventory
router.post('/', requireAdmin, itemController.createItem);
router.post('/upload-excel', requireAdmin, upload.single('excelFile'), itemController.uploadExcel);
router.post('/upload-image', requireAdmin, imageUpload.single('image'), itemController.uploadImage);

router.get('/:id', itemController.getItem);
router.patch('/:id', requireAdmin, itemController.updateItem);
router.delete('/:id', requireAdmin, itemController.deleteItem);


module.exports = router;
