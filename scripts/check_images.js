require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Item = require('../models/Item');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const total = await Item.countDocuments();
  const base64Count = await Item.countDocuments({ image: { $regex: '^data:image/' } });
  const filePathCount = await Item.countDocuments({ image: { $regex: '^/uploads/' } });
  const emptyCount = await Item.countDocuments({ image: '' });

  console.log('Total items:', total);
  console.log('Already base64 in DB:', base64Count);
  console.log('Still file-path in DB:', filePathCount);
  console.log('No image:', emptyCount);

  if (filePathCount > 0) {
    const samples = await Item.find({ image: { $regex: '^/uploads/' } }).limit(3).select('customId image');
    console.log('Sample file-path items:', JSON.stringify(samples.map(i => ({ id: i.customId, img: i.image })), null, 2));
  }

  await mongoose.disconnect();
  process.exit(0);
}).catch(err => { console.error(err); process.exit(1); });
