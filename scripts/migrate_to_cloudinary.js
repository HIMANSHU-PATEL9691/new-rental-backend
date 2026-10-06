/**
 * migrate_to_cloudinary.js
 * 
 * Migrates all Base64 images in MongoDB to Cloudinary and saves the HTTPS Cloudinary URL in MongoDB.
 * Run: node scripts/migrate_to_cloudinary.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Item = require('../models/Item');
const { uploadToCloudinary } = require('../utils/cloudinary');

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI missing in .env');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  const items = await Item.find({ image: { $regex: '^data:image/' } });
  console.log(`Found ${items.length} items with Base64 images to migrate to Cloudinary.`);

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const cloudinaryUrl = await uploadToCloudinary(item.image, 'rental_items');
      item.image = cloudinaryUrl;
      await item.save();
      successCount++;
      console.log(`[${i + 1}/${items.length}] ✓ Migrated item ${item.customId || item._id} to Cloudinary: ${cloudinaryUrl}`);
    } catch (err) {
      errorCount++;
      console.error(`[${i + 1}/${items.length}] ✗ Error migrating item ${item.customId || item._id}:`, err.message);
    }
  }

  console.log('\n=== Cloudinary Migration Summary ===');
  console.log(`✓ Successfully migrated to Cloudinary: ${successCount}`);
  console.log(`✗ Errors: ${errorCount}`);

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB. Done.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Fatal error during migration:', err);
  process.exit(1);
});
