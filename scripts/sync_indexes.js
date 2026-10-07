const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const Item = require('../models/Item');

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI missing');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const indexes = await Item.collection.indexes();
    console.log('Existing indexes on items collection:', indexes.map(i => i.name));

    const hasLegacy = indexes.some(i => i.name === 'customId_1');
    if (hasLegacy) {
      console.log('Dropping legacy global customId_1 index...');
      await Item.collection.dropIndex('customId_1');
      console.log('Successfully dropped customId_1 index.');
    }

    console.log('Syncing Item indexes...');
    await Item.syncIndexes();

    const updatedIndexes = await Item.collection.indexes();
    console.log('Updated indexes on items collection:', updatedIndexes.map(i => ({ name: i.name, key: i.key, unique: i.unique })));

    console.log('Index migration complete successfully!');
  } catch (err) {
    console.error('Error syncing indexes:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

run();
