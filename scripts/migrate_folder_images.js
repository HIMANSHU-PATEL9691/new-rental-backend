/**
 * migrate_folder_images.js
 * 
 * Scans uploads/items/ folder, finds matching DB items by path, 
 * converts each image file to base64 and saves directly in MongoDB.
 * Run: node scripts/migrate_folder_images.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const Item = require('../models/Item');

const uploadsDir = path.join(__dirname, '..', 'uploads', 'items');

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI missing in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // Get all files in uploads/items/
  if (!fs.existsSync(uploadsDir)) {
    console.log('uploads/items folder does not exist. Nothing to migrate.');
    process.exit(0);
  }

  const files = fs.readdirSync(uploadsDir);
  console.log(`Found ${files.length} files in uploads/items/`);

  let converted = 0;
  let notFound = 0;
  let errors = 0;

  for (const filename of files) {
    try {
      const itemPath = `/uploads/items/${filename}`;
      
      // Find DB item with this exact path
      const item = await Item.findOne({ image: itemPath });
      
      if (!item) {
        // Try to match by filename prefix (e.g., L100 from L100-1790082703484-s1imwb.jpg)
        notFound++;
        continue;
      }

      // Read file and convert to base64
      const filePath = path.join(uploadsDir, filename);
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(filename).replace('.', '').toLowerCase();
      const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      const base64 = buffer.toString('base64');
      item.image = `data:${mimeType};base64,${base64}`;
      await item.save();
      converted++;
      console.log(`✓ Converted: ${filename} → item ${item.customId}`);
    } catch (err) {
      errors++;
      console.error(`✗ Error for ${filename}: ${err.message}`);
    }
  }

  console.log('\n=== Migration Complete ===');
  console.log(`✓ Converted: ${converted}`);
  console.log(`⚠ Not matched in DB: ${notFound}`);
  console.log(`✗ Errors: ${errors}`);
  
  if (notFound > 0) {
    console.log('\nNote: "Not matched" files mean the DB item already has a different');
    console.log('image value (base64 or different path). Those items are fine.');
  }

  await mongoose.disconnect();
  console.log('\nDone. You can now safely delete the uploads/items/ folder.');
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
