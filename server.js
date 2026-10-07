const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

let dbReady = false;
let dbError = null;

// Ensure uploads directory exists and serve static uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const compression = require('compression');

// Middleware
app.use(compression());
app.use(cors({
  origin: true, // Dynamically reflects your frontend origin (fixes port mismatches like 5174)
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(uploadsDir, {
  maxAge: '1d',
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  }
}));

// Home Route
app.get("/", (req, res) => {
  res.send("Rental Backend Running Successfully");
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    database: dbReady ? 'connected' : 'connecting',
    databaseError: dbError,
    timestamp: new Date().toISOString(),
  });
});

// API middleware
app.use('/api', (req, res, next) => {
  console.log(`[api] ${req.method} ${req.originalUrl}`);

  if (dbReady) {
    next();
    return;
  }

  res.status(503).json({
    error: dbError || 'Database is still connecting. Please try again in a moment.',
  });
});

// Routes
const authController = require('./controllers/authController');

// Staff management endpoints
app.get('/api/auth/users', authController.getUsers);
app.put('/api/auth/users/:identifier/status', authController.updateUserStatus);
app.put('/api/auth/users/:identifier/password', authController.updateUserPassword);
app.delete('/api/auth/users/:identifier', authController.deleteUser);

// Auth routes
function safeRequire(routePath) {
  try {
    return require(routePath);
  } catch (err) {
    console.error(`[Warning] Could not load ${routePath}: ${err.message}`);
    const router = express.Router();
    router.all('*', (req, res) => res.status(501).json({ error: `API route not implemented yet: ${routePath}` }));
    return router;
  }
}

app.use('/api/auth', safeRequire('./routes/auth'));
app.use('/api/items', safeRequire('./routes/items'));
app.use('/api/customers', safeRequire('./routes/customers'));
app.use('/api/rentals', safeRequire('./routes/rentals'));
app.use('/api/bills', safeRequire('./routes/bills'));

// 404
app.use('*', (req, res) => {
  res.status(404).json({ error: `Route ${req.originalUrl} not found` });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`API health: http://localhost:${PORT}/health`);
});

// MongoDB Connect
const Item = require('./models/Item');
const Customer = require('./models/Customer');
const Rental = require('./models/Rental');
const User = require('./models/User');

async function migrateBranchData() {
  try {
    await Item.updateMany({ $or: [{ branch: { $exists: false } }, { branch: null }, { branch: '' }] }, { $set: { branch: 'Shop 1' } });
    await Customer.updateMany({ $or: [{ branch: { $exists: false } }, { branch: null }, { branch: '' }] }, { $set: { branch: 'Shop 1' } });
    await Rental.updateMany({ $or: [{ branch: { $exists: false } }, { branch: null }, { branch: '' }] }, { $set: { branch: 'Shop 1' } });
    await User.updateMany({ $or: [{ branch: { $exists: false } }, { branch: null }, { branch: '' }] }, { $set: { branch: 'Shop 1' } });
    console.log('[DB] Multi-branch migration complete. Existing records assigned to Shop 1.');
  } catch (err) {
    console.error('[DB] Migration error:', err.message);
  }
}

const { uploadToCloudinary } = require('./utils/cloudinary');

// Migrate existing file-path images (/uploads/items/xxx.jpg) to Cloudinary in MongoDB.
async function migrateFilesToCloudinary() {
  try {
    const items = await Item.find({ image: { $regex: '^/uploads/items/' } });
    if (items.length === 0) {
      return;
    }
    let migrated = 0;
    for (const item of items) {
      try {
        const filePath = path.join(__dirname, item.image);
        if (!fs.existsSync(filePath)) {
          continue;
        }
        const buffer = fs.readFileSync(filePath);
        const cloudinaryUrl = await uploadToCloudinary(buffer, 'rental_items');
        item.image = cloudinaryUrl;
        await item.save();
        migrated++;
      } catch (fileErr) {
        console.error(`[DB] Failed to migrate image for item ${item.customId}:`, fileErr.message);
      }
    }
    if (migrated > 0) {
      console.log(`[DB] Migrated ${migrated} disk images to Cloudinary.`);
    }
  } catch (err) {
    console.error('[DB] Image migration error:', err.message);
  }
}


async function fixIndexes() {
  try {
    const indexes = await Item.collection.indexes();
    const hasLegacyCustomIdIndex = indexes.some((idx) => idx.name === 'customId_1');
    if (hasLegacyCustomIdIndex) {
      await Item.collection.dropIndex('customId_1');
      console.log('[DB] Dropped legacy global customId_1 index from items collection.');
    }
    await Item.syncIndexes();
    console.log('[DB] Synced indexes for Item model (compound customId + branch index is active).');
  } catch (err) {
    console.warn('[DB] Index fix warning:', err.message);
  }
}

if (!process.env.MONGODB_URI) {
  dbReady = false;
  dbError = 'MONGODB_URI is missing in .env file';
  console.error('[DB] ' + dbError);
} else {
  mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
      dbReady = true;
      dbError = null;
      console.log('Connected to MongoDB Atlas');
      await migrateBranchData();
      await fixIndexes();
      await migrateFilesToCloudinary();
    })
    .catch((err) => {
      dbReady = false;
      dbError = `MongoDB connection error: ${err.message}`;
      console.error(dbError);
    });
}

module.exports = app;