require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Item = require('../models/Item');

async function migrateImages() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  const uploadDir = path.join(__dirname, '..', 'uploads', 'items');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const items = await Item.find({ image: { $regex: '^data:image/' } });
  console.log(`Found ${items.length} items with base64 image data to migrate.`);

  let migratedCount = 0;
  let errorCount = 0;

  for (const item of items) {
    try {
      const matches = item.image.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
      if (!matches) {
        console.warn(`Could not match base64 regex for item ${item.customId}`);
        errorCount++;
        continue;
      }

      let ext = matches[1].toLowerCase();
      if (ext === 'jpeg') ext = 'jpg';
      const buffer = Buffer.from(matches[2], 'base64');
      const safeId = (item.customId || 'item').replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `${safeId}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${ext}`;
      const filepath = path.join(uploadDir, filename);

      fs.writeFileSync(filepath, buffer);

      item.image = `/uploads/items/${filename}`;
      await item.save();

      migratedCount++;
      if (migratedCount % 10 === 0 || migratedCount === items.length) {
        console.log(`Migrated ${migratedCount}/${items.length} images...`);
      }
    } catch (err) {
      console.error(`Error migrating item ${item.customId}:`, err.message);
      errorCount++;
    }
  }

  console.log(`\nMigration completed! Successfully migrated: ${migratedCount}, Errors: ${errorCount}`);
  await mongoose.disconnect();
}

migrateImages().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
