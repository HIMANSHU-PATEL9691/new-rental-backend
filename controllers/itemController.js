const mongoose = require('mongoose');
const Item = require('../models/Item');
const { ItemStatus } = require('../types');
const XLSX = require('xlsx');
const { uploadToCloudinary, deleteFromCloudinary } = require('../utils/cloudinary');

let itemsCache = null;
let itemsCacheTime = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds TTL

function invalidateItemsCache() {
  itemsCache = null;
  itemsCacheTime = 0;
}
exports.invalidateItemsCache = invalidateItemsCache;

function buildItemIdentifierQuery(identifier, branch) {
  const str = String(identifier || '').trim();
  if (!str) return null;
  if (mongoose.Types.ObjectId.isValid(str)) {
    return {
      $or: [
        { customId: new RegExp(`^${str}$`, 'i') },
        { _id: new mongoose.Types.ObjectId(str) },
      ],
    };
  }
  const query = { customId: new RegExp(`^${str}$`, 'i') };
  if (branch) {
    if (branch === 'Shop 1') {
      query.$or = [{ branch: 'Shop 1' }, { branch: { $exists: false } }, { branch: null }, { branch: '' }];
    } else {
      query.branch = branch;
    }
  }
  return query;
}

// GET /api/items - list all or filter by status & branch
exports.getItems = async (req, res) => {
  try {
    const { status, branch } = req.query;
    const targetBranch = branch || 'Shop 1';
    const cacheKey = `${targetBranch}_${status || 'all'}`;

    if (itemsCache && itemsCache[cacheKey] && (Date.now() - itemsCacheTime < CACHE_TTL)) {
      return res.json(itemsCache[cacheKey]);
    }

    const query = {};
    if (status) query.status = status;
    
    if (targetBranch === 'Shop 1') {
      query.$or = [{ branch: 'Shop 1' }, { branch: { $exists: false } }, { branch: null }, { branch: '' }];
    } else {
      query.branch = targetBranch;
    }

    const items = await Item.find(query).sort({ createdAt: -1 }).lean();
    if (!itemsCache) itemsCache = {};
    itemsCache[cacheKey] = items;
    itemsCacheTime = Date.now();

    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/items/:id
exports.getItem = async (req, res) => {
  try {
    const branch = req.query.branch;
    const query = buildItemIdentifierQuery(req.params.id, branch);
    if (!query) return res.status(404).json({ error: 'Item not found' });
    const item = await Item.findOne(query).lean();
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/items — ensures image is uploaded to Cloudinary before saving URL to MongoDB
exports.createItem = async (req, res) => {
  try {
    const itemData = { ...req.body };

    // Handle primary image
    if (typeof itemData.image === 'string' && itemData.image.startsWith('data:image/')) {
      try {
        itemData.image = await uploadToCloudinary(itemData.image, 'rental_items');
      } catch (cloudErr) {
        console.error('[Cloudinary] createItem main image upload error:', cloudErr.message);
      }
    }

    // Handle gallery images
    if (Array.isArray(itemData.images) && itemData.images.length > 0) {
      itemData.images = await Promise.all(
        itemData.images.map(async (img, idx) => {
          if (idx === 0 && itemData.image && !itemData.image.startsWith('data:image/')) {
            return itemData.image;
          }
          if (typeof img === 'string' && img.startsWith('data:image/')) {
            try {
              return await uploadToCloudinary(img, 'rental_items');
            } catch (err) {
              console.error('[Cloudinary] createItem gallery image upload error:', err.message);
              return img;
            }
          }
          return img;
        })
      );
      if (!itemData.image && itemData.images[0]) {
        itemData.image = itemData.images[0];
      }
    } else if (itemData.image) {
      itemData.images = [itemData.image];
    }

    const item = new Item(itemData);
    await item.save();
    invalidateItemsCache();
    res.status(201).json(item);
  } catch (err) {
    if (err.code === 11000 || (err.message && err.message.includes('E11000'))) {
      const branchName = req.body.branch || 'current shop';
      const dupField = err.keyPattern ? Object.keys(err.keyPattern)[0] : 'Item No';
      const dupVal = err.keyValue ? err.keyValue[dupField] : (req.body.customId || '');
      return res.status(400).json({
        error: `Item with ${dupField === 'customId' ? 'Item No' : dupField} "${dupVal}" already exists in ${branchName}. Please use a unique Item No for this shop.`
      });
    }
    res.status(400).json({ error: err.message });
  }
};

// PATCH /api/items/:id — ensures image is uploaded to Cloudinary and old replaced image is deleted
exports.updateItem = async (req, res) => {
  try {
    const updateData = { ...req.body };
    const branch = req.query.branch || updateData.branch;
    const query = buildItemIdentifierQuery(req.params.id, branch);
    if (!query) return res.status(404).json({ error: 'Item not found' });

    const existingItem = await Item.findOne(query);
    if (!existingItem) return res.status(404).json({ error: 'Item not found' });

    // Handle updated primary image
    if (typeof updateData.image === 'string' && updateData.image.startsWith('data:image/')) {
      try {
        updateData.image = await uploadToCloudinary(updateData.image, 'rental_items');
      } catch (cloudErr) {
        console.error('[Cloudinary] updateItem upload error:', cloudErr.message);
      }
    }

    // If the main image was replaced with a new one, delete old Cloudinary image
    if (updateData.image && existingItem.image && updateData.image !== existingItem.image) {
      deleteFromCloudinary(existingItem.image).catch((e) =>
        console.warn('[Cloudinary] old image delete error:', e.message)
      );
    }

    // Handle gallery images
    if (Array.isArray(updateData.images)) {
      updateData.images = await Promise.all(
        updateData.images.map(async (img, idx) => {
          if (idx === 0 && updateData.image && !updateData.image.startsWith('data:image/')) {
            return updateData.image;
          }
          if (typeof img === 'string' && img.startsWith('data:image/')) {
            try {
              return await uploadToCloudinary(img, 'rental_items');
            } catch (err) {
              console.error('[Cloudinary] updateItem gallery image upload error:', err.message);
              return img;
            }
          }
          return img;
        })
      );

      // Delete removed images from Cloudinary
      if (Array.isArray(existingItem.images)) {
        for (const oldImg of existingItem.images) {
          if (oldImg && !updateData.images.includes(oldImg) && oldImg !== updateData.image) {
            deleteFromCloudinary(oldImg).catch((e) =>
              console.warn('[Cloudinary] removed image delete error:', e.message)
            );
          }
        }
      }
    }
    
    const item = await Item.findOneAndUpdate(
      query,
      updateData,
      { new: true }
    );
    if (!item) return res.status(404).json({ error: 'Item not found' });
    invalidateItemsCache();
    res.json(item);
  } catch (err) {
    if (err.code === 11000 || (err.message && err.message.includes('E11000'))) {
      const branchName = req.body.branch || req.query.branch || 'current shop';
      const dupField = err.keyPattern ? Object.keys(err.keyPattern)[0] : 'Item No';
      const dupVal = err.keyValue ? err.keyValue[dupField] : (req.body.customId || '');
      return res.status(400).json({
        error: `Item with ${dupField === 'customId' ? 'Item No' : dupField} "${dupVal}" already exists in ${branchName}. Please use a unique Item No for this shop.`
      });
    }
    res.status(400).json({ error: err.message });
  }
};


// DELETE /api/items/:id — deletes item and its associated Cloudinary images
exports.deleteItem = async (req, res) => {
  try {
    const branch = req.query.branch;
    const query = buildItemIdentifierQuery(req.params.id, branch);
    if (!query) return res.status(404).json({ error: 'Item not found' });
    const item = await Item.findOneAndDelete(query);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Delete image(s) from Cloudinary
    if (item.image) {
      deleteFromCloudinary(item.image).catch((e) =>
        console.warn('[Cloudinary] deleteItem image error:', e.message)
      );
    }
    if (Array.isArray(item.images)) {
      for (const img of item.images) {
        if (img && img !== item.image) {
          deleteFromCloudinary(img).catch((e) =>
            console.warn('[Cloudinary] deleteItem gallery image error:', e.message)
          );
        }
      }
    }

    invalidateItemsCache();
    res.json({ message: 'Item and associated images deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/items/upload-excel
exports.uploadExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    let jsonData;
    if (req.file.mimetype === 'text/csv' || req.file.originalname.endsWith('.csv')) {
      const csvText = req.file.buffer.toString('utf-8');
      const lines = csvText.split('\n').filter(line => line.trim());
      if (lines.length === 0) {
        return res.status(400).json({ error: 'CSV file is empty' });
      }
      const headers = lines[0].split(',').map(h => h.trim());
      jsonData = lines.slice(1).map(line => {
        const values = line.split(',');
        const obj = {};
        headers.forEach((header, index) => {
          obj[header] = values[index]?.trim() || '';
        });
        return obj;
      });
    } else {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      jsonData = XLSX.utils.sheet_to_json(worksheet);
    }

    if (jsonData.length === 0) {
      return res.status(400).json({ error: 'File is empty or no valid data found' });
    }

    const items = [];
    const errors = [];

    for (let i = 0; i < jsonData.length; i++) {
      const row = jsonData[i];
      try {
        const itemData = {
          name: row.name || row.Name,
          designer: row.designer || row.Designer,
          category: row.category || row.Category,
          subcategory: row.subcategory || row.Subcategory,
          size: row.size || row.Size,
          color: row.color || row.Color,
          pricePerDay: parseFloat(row.pricePerDay || row['Price Per Day'] || row.price_per_day),
          retailValue: parseFloat(row.retailValue || row['Retail Value'] || row.retail_value),
          quantity: Math.max(0, parseInt(row.quantity || row.Quantity || row.qty || row.Qty || 1, 10) || 1),
          image: row.image || row.Image || '',
          branch: req.body.branch || row.branch || row.Branch || 'Shop 1',
          status: ItemStatus.AVAILABLE,
          timesRented: 0
        };

        if (!itemData.name || !itemData.designer || !itemData.category || 
            !itemData.subcategory || !itemData.size || !itemData.color ||
            isNaN(itemData.pricePerDay) || isNaN(itemData.retailValue)) {
          errors.push(`Row ${i + 2}: Missing or invalid required fields`);
          continue;
        }

        const item = new Item(itemData);
        await item.save();
        items.push(item);
      } catch (err) {
        errors.push(`Row ${i + 2}: ${err.message}`);
      }
    }

    invalidateItemsCache();
    res.status(201).json({
      message: `Successfully uploaded ${items.length} items`,
      items: items.map(item => ({ id: item.customId, name: item.name })),
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/items/upload-image
// Uploads image to Cloudinary and returns secure HTTPS URL.
// Falls back to base64 data URI if Cloudinary upload fails.
exports.uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    try {
      const cloudinaryUrl = await uploadToCloudinary(req.file.buffer, 'rental_items');
      return res.status(200).json({ url: cloudinaryUrl });
    } catch (cloudErr) {
      console.warn('[Cloudinary] Upload failed, falling back to base64:', cloudErr.message);
      const mimeType = req.file.mimetype || 'image/jpeg';
      const base64 = req.file.buffer.toString('base64');
      const dataUri = `data:${mimeType};base64,${base64}`;
      return res.status(200).json({ url: dataUri });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


