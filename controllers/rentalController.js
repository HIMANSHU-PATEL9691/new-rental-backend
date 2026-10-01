const mongoose = require('mongoose');
const Rental = require('../models/Rental');
const Item = require('../models/Item');
const Customer = require('../models/Customer');
const { RentalStatus, ItemStatus } = require('../types');

// GET /api/rentals
exports.getRentals = async (req, res) => {
  try {
    const targetBranch = req.query.branch || 'Shop 1';
    const filter = {};
    if (targetBranch === 'Shop 1') {
      filter.$or = [{ branch: 'Shop 1' }, { branch: { $exists: false } }, { branch: null }, { branch: '' }];
    } else {
      filter.branch = targetBranch;
    }
    const rentals = await Rental.find(filter)
      .populate('item', 'customId name designer category subcategory size color pricePerDay quantity status image branch')
      .populate('customer', 'customId name phone email tier branch')
      .sort({ createdAt: -1 })
      .lean();
    res.json(rentals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/rentals/:id
exports.getRental = async (req, res) => {
  try {
    const rental = await Rental.findOne({ customId: req.params.id })
      .populate('item', 'customId name designer category subcategory size color pricePerDay quantity status image branch')
      .populate('customer', 'customId name phone email tier branch')
      .lean();
    if (!rental) return res.status(404).json({ error: 'Rental not found' });
    res.json(rental);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/rentals - complex: compute total, update item/customer
exports.createRental = async (req, res) => {
  try {
    const {
      itemId,
      customerId,
      billNo,
      address,
      itemNo,
      deliveryDate,
      deliveryTime = '',
      deliveryTimePeriod = '',
      startDate,
      endDate,
      endTime = '',
      endTimePeriod = '',
      rate = 0,
      quantity = 1,
      lostQuantity = 0,
      discount = 0,
      penalty = 0,
      remark = '',
      advance = 0,
      securityAmount = 0,
      securityReturned = false,
      securityReturnedAt = null,
      signature = '',
      total,
      status,
      ownerNumber = '',
      instaId = '',
      billMakingDate = null,
      confirmationChecked = false,
      branch = 'Shop 1',
    } = req.body;

    // Frontend sends lowercase statuses; normalize defensively.
    let normalizedStatus = status;
    if (typeof normalizedStatus === 'string') {
      normalizedStatus = normalizedStatus.toLowerCase();
    }
    if (!normalizedStatus || !Object.values(RentalStatus).includes(normalizedStatus)) {
      // Default to UPCOMING if invalid/missing.
      normalizedStatus = RentalStatus.UPCOMING;
    }

    // Validate references
    let item = null;
    const itemCode = (itemNo || itemId || '').toString().trim();
    if (itemCode) {
      item = await Item.findOne({ customId: new RegExp(`^${itemCode}$`, 'i') });
      if (!item && mongoose.Types.ObjectId.isValid(itemCode)) {
        item = await Item.findById(itemCode);
      }
      if (!item) {
        item = await Item.findOne({ barcode: itemCode });
      }
    }
    if (!item && itemId) {
      item = await Item.findOne({ customId: itemId });
      if (!item && mongoose.Types.ObjectId.isValid(itemId)) {
        item = await Item.findById(itemId);
      }
    }
    if (!item) {
      return res.status(404).json({ error: `Item "${itemNo || itemId}" is not present in inventory. Cannot make bill.` });
    }

    const customer = await Customer.findOne({ customId: customerId }) || (mongoose.Types.ObjectId.isValid(customerId) ? await Customer.findById(customerId) : null);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Validate that item is not already booked for overlapping dates (unless Safa with stock)
    const isSafa = [item.name, item.category, item.subcategory].filter(Boolean).join(' ').toLowerCase().includes('safa');
    if (!isSafa) {
      const rentalStart = new Date(deliveryDate || startDate);
      const rentalEnd = new Date(endDate);
      const overlap = await Rental.findOne({
        item: item._id,
        status: { $in: [RentalStatus.ACTIVE, RentalStatus.UPCOMING, RentalStatus.OVERDUE] },
        $or: [
          { startDate: { $lte: rentalEnd }, endDate: { $gte: rentalStart } },
          { deliveryDate: { $lte: rentalEnd }, endDate: { $gte: rentalStart } },
        ],
      });
      if (overlap) {
        return res.status(400).json({
          error: `Item "${item.name}" is already booked for the selected dates.`,
        });
      }
    }

    const rental = new Rental({
      branch: branch || 'Shop 1',
      item: item._id,
      customer: customer._id,
      billNo,
      address,
      itemNo: item.customId || itemNo,
      deliveryDate: deliveryDate ? new Date(deliveryDate) : null,
      deliveryTime: deliveryTime || '',
      deliveryTimePeriod: deliveryTimePeriod || '',
      startDate: new Date(startDate || deliveryDate),
      endDate: new Date(endDate),
      endTime: endTime || '',
      endTimePeriod: endTimePeriod || '',
      rate: Number(rate) || Number(total) || 0,
      quantity: Math.max(0, Number(quantity) || 1),
      lostQuantity: Math.max(0, Number(lostQuantity) || 0),
      discount: Number(discount) || 0,
      penalty: Number(penalty) || 0,
      remark,
      advance: Number(advance) || 0,
      securityAmount: Number(securityAmount) || 0,
      securityReturned: Boolean(securityReturned),
      securityReturnedAt: securityReturnedAt ? new Date(securityReturnedAt) : null,
      signature,
      total: Number(total) || 0,
      status: normalizedStatus,
      ownerNumber: ownerNumber || '',
      instaId: instaId || '',
      billMakingDate: billMakingDate ? new Date(billMakingDate) : null,
      confirmationChecked: Boolean(confirmationChecked),
    });
    await rental.save();

    // Update item
    item.timesRented += 1;
    if (normalizedStatus === RentalStatus.ACTIVE) item.status = ItemStatus.RENTED;
    else if (normalizedStatus === RentalStatus.UPCOMING) item.status = ItemStatus.RESERVED;
    await item.save();

    // Update customer
    customer.rentals += 1;
    customer.totalSpent += Number(total) || 0;
    await customer.save();

    const populatedRental = await Rental.findById(rental._id).populate('item customer');
    res.status(201).json(populatedRental);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// PATCH /api/rentals/:id
exports.updateRental = async (req, res) => {
  try {
    const userRole = String(req.get('x-user-role') || req.headers['x-user-role'] || '')
      .trim()
      .toLowerCase();
    const updates = { ...req.body };
    const updateKeys = Object.keys(updates);

    if (typeof updates.remarkConfirmedBy === 'string') {
      updates.remarkConfirmedBy = updates.remarkConfirmedBy.trim();
    }
    if (typeof updates.fittingCompletedBy === 'string') {
      updates.fittingCompletedBy = updates.fittingCompletedBy.trim();
    }
    if (typeof updates.drycleanCompletedBy === 'string') {
      updates.drycleanCompletedBy = updates.drycleanCompletedBy.trim();
    }
    if (typeof updates.drycleanAdminConfirmedBy === 'string') {
      updates.drycleanAdminConfirmedBy = updates.drycleanAdminConfirmedBy.trim();
    }
    if (typeof updates.adminReconfirmedBy === 'string') {
      updates.adminReconfirmedBy = updates.adminReconfirmedBy.trim();
    }
    if (updates.remarkCompleted != null) {
      updates.remarkCompleted = Boolean(updates.remarkCompleted);
    }
    if (updates.fittingCompleted != null) {
      updates.fittingCompleted = Boolean(updates.fittingCompleted);
    }
    if (updates.drycleanCompleted != null) {
      updates.drycleanCompleted = Boolean(updates.drycleanCompleted);
    }
    if (updates.adminReconfirmed != null) {
      updates.adminReconfirmed = Boolean(updates.adminReconfirmed);
    }
    if (updates.adminReconfirmedAt) {
      updates.adminReconfirmedAt = new Date(updates.adminReconfirmedAt);
    }
    if (updates.drycleanAdminConfirmed != null) {
      updates.drycleanAdminConfirmed = Boolean(updates.drycleanAdminConfirmed);
    }
    if (updates.drycleanAdminConfirmedAt) {
      updates.drycleanAdminConfirmedAt = new Date(updates.drycleanAdminConfirmedAt);
    }
    if (updates.securityReturned != null) {
      updates.securityReturned = Boolean(updates.securityReturned);
    }
    if (updates.securityReturnedAt) {
      updates.securityReturnedAt = new Date(updates.securityReturnedAt);
    }
    if (updates.returnedAt) {
      updates.returnedAt = new Date(updates.returnedAt);
    }

    console.info('[rentals] update request', {
      id: req.params.id,
      userRole: userRole || '(missing)',
      updateKeys,
    });

    const allowedEmployeeUpdates = ['remarkCompleted', 'remarkConfirmedBy', 'fittingCompleted', 'fittingCompletedBy', 'drycleanCompleted', 'drycleanCompletedBy'];
    const allowedEmployeeDeliveryUpdates = ['status', 'advance', 'securityReturned', 'securityReturnedAt', 'returnedAt'];
    const isReadyUpdate = updateKeys.length > 0 && updateKeys.every(update => allowedEmployeeUpdates.includes(update));
    const isDeliveryUpdate = updateKeys.length > 0 && updateKeys.every(update =>
      [...allowedEmployeeUpdates, ...allowedEmployeeDeliveryUpdates].includes(update)
    );

    if (userRole === 'employee') {
      if (!isReadyUpdate && !isDeliveryUpdate) {
        return res.status(403).json({ error: 'Employees can only update rental readiness, fitting completion, dryclean completion, or delivery/return status.' });
      }
      if (updates.remarkCompleted === true && !updates.remarkConfirmedBy) {
        return res.status(400).json({ error: 'Employee name is required to mark a rental as ready.' });
      }
      if (updates.fittingCompleted === true && !updates.fittingCompletedBy) {
        return res.status(400).json({ error: 'Employee name is required to mark fitting as completed.' });
      }
      if (updates.drycleanCompleted === true && !updates.drycleanCompletedBy) {
        return res.status(400).json({ error: 'Employee name is required to mark dryclean as completed.' });
      }
    } else if (userRole !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    if (updates.adminReconfirmed === true && !updates.adminReconfirmedBy) {
      return res.status(400).json({ error: 'Admin name is required to reconfirm a rental.' });
    }
    if (updates.drycleanAdminConfirmed === true && !updates.drycleanAdminConfirmedBy) {
      return res.status(400).json({ error: 'Admin name is required to confirm dryclean.' });
    }

    if (updates && typeof updates.status === 'string') {
      updates.status = updates.status.toLowerCase();
      if (!Object.values(RentalStatus).includes(updates.status)) {
        delete updates.status;
      }
    }
    if (updates.quantity != null) {
      updates.quantity = Math.max(0, Number(updates.quantity) || 1);
    }
    if (updates.lostQuantity != null) {
      updates.lostQuantity = Math.max(0, Number(updates.lostQuantity) || 0);
    }
    const rental = await Rental.findOne({ customId: req.params.id }).populate('item customer');
    if (!rental) return res.status(404).json({ error: 'Rental not found' });

    const oldStatus = rental.status;
    const oldPenalty = rental.penalty || 0;
    const oldItemDoc = rental.item;

    // Date normalization
    if (updates.deliveryDate === '' || updates.deliveryDate === null) {
      updates.deliveryDate = null;
    } else if (updates.deliveryDate) {
      updates.deliveryDate = new Date(updates.deliveryDate);
    }
    if (updates.startDate) {
      updates.startDate = new Date(updates.startDate);
    }
    if (updates.endDate) {
      updates.endDate = new Date(updates.endDate);
    }
    if (updates.billMakingDate === '' || updates.billMakingDate === null) {
      updates.billMakingDate = null;
    } else if (updates.billMakingDate) {
      updates.billMakingDate = new Date(updates.billMakingDate);
    }

    // Resolve Item reference when itemId or itemNo is updated
    let newItem = null;
    const itemNoCode = updates.itemNo ? String(updates.itemNo).trim() : '';
    const itemIdCode = updates.itemId ? String(updates.itemId).trim() : '';

    if (itemNoCode) {
      newItem = await Item.findOne({ customId: new RegExp(`^${itemNoCode}$`, 'i') });
      if (!newItem && mongoose.Types.ObjectId.isValid(itemNoCode)) {
        newItem = await Item.findById(itemNoCode);
      }
      if (!newItem) {
        newItem = await Item.findOne({ barcode: itemNoCode });
      }
    }
    if (!newItem && itemIdCode) {
      newItem = await Item.findOne({ customId: new RegExp(`^${itemIdCode}$`, 'i') });
      if (!newItem && mongoose.Types.ObjectId.isValid(itemIdCode)) {
        newItem = await Item.findById(itemIdCode);
      }
    }

    if (newItem) {
      rental.item = newItem._id;
      rental.itemNo = newItem.customId || updates.itemNo;
    } else if (itemNoCode || itemIdCode) {
      return res.status(404).json({ error: `Item "${itemNoCode || itemIdCode}" is not present in inventory. Cannot update rental.` });
    }

    // Resolve Customer reference when customerId is updated
    if (updates.customerId) {
      const rawCustCode = String(updates.customerId).trim();
      let newCustomer = await Customer.findOne({ customId: new RegExp(`^${rawCustCode}$`, 'i') });
      if (!newCustomer && mongoose.Types.ObjectId.isValid(rawCustCode)) {
        newCustomer = await Customer.findById(rawCustCode);
      }
      if (newCustomer) {
        rental.customer = newCustomer._id;
      }
    }

    // Remove virtual non-schema keys so Object.assign does not corrupt document
    delete updates.itemId;
    delete updates.customerId;
    delete updates.item;
    delete updates.customer;

    Object.assign(rental, updates);

    // If item was changed to a different item, update availability of old and new item
    if (newItem && oldItemDoc && String(newItem._id) !== String(oldItemDoc._id)) {
      try {
        const otherOpenForOld = await Rental.findOne({
          _id: { $ne: rental._id },
          item: oldItemDoc._id,
          status: { $in: [RentalStatus.ACTIVE, RentalStatus.UPCOMING, RentalStatus.OVERDUE] },
        });
        if (!otherOpenForOld) {
          await Item.findByIdAndUpdate(oldItemDoc._id, { status: ItemStatus.AVAILABLE });
        }
        if ([RentalStatus.ACTIVE, RentalStatus.OVERDUE].includes(rental.status)) {
          await Item.findByIdAndUpdate(newItem._id, { status: ItemStatus.RENTED });
        } else if (rental.status === RentalStatus.UPCOMING) {
          await Item.findByIdAndUpdate(newItem._id, { status: ItemStatus.RESERVED });
        }
      } catch (err) {
        console.error('[rentals] error updating item statuses on item change', err);
      }
    }

    // If an employee marked dryclean completed, set item status to CLEANING
    if (updates.drycleanCompleted === true && rental.item) {
      try {
        await Item.findByIdAndUpdate(rental.item, { status: ItemStatus.CLEANING });
      } catch (err) {
        console.error('[rentals] failed to set item status to CLEANING', err);
      }
    }

    // If admin confirmed dryclean, mark item available
    if (updates.drycleanAdminConfirmed === true && rental.item) {
      try {
        await Item.findByIdAndUpdate(rental.item, { status: ItemStatus.AVAILABLE });
      } catch (err) {
        console.error('[rentals] failed to set item status to AVAILABLE after dryclean confirm', err);
      }
    }

    if (updates.penalty != null && rental.customer) {
      const penaltyDelta = Number(updates.penalty) - Number(oldPenalty);
      if (!Number.isNaN(penaltyDelta) && penaltyDelta !== 0) {
        rental.customer.totalSpent += penaltyDelta;
        await rental.customer.save();
      }
    }

    if (updates.status && updates.status !== oldStatus && rental.item) {
      try {
        const itemToUpdate = await Item.findById(rental.item);
        if (itemToUpdate) {
          if ([RentalStatus.ACTIVE, RentalStatus.OVERDUE].includes(updates.status)) {
            itemToUpdate.status = ItemStatus.RENTED;
          } else if (updates.status === RentalStatus.UPCOMING) {
            itemToUpdate.status = ItemStatus.RESERVED;
          } else if (updates.status === RentalStatus.RETURNED) {
            const otherOpenRental = await Rental.findOne({
              _id: { $ne: rental._id },
              item: itemToUpdate._id,
              status: { $in: [RentalStatus.ACTIVE, RentalStatus.OVERDUE, RentalStatus.UPCOMING] },
            }).sort({ createdAt: -1 });

            if (otherOpenRental?.status === RentalStatus.ACTIVE || otherOpenRental?.status === RentalStatus.OVERDUE) {
              itemToUpdate.status = ItemStatus.RENTED;
            } else if (otherOpenRental?.status === RentalStatus.UPCOMING) {
              itemToUpdate.status = ItemStatus.RESERVED;
            } else {
              itemToUpdate.status = ItemStatus.AVAILABLE;
            }
          }
          await itemToUpdate.save();
        }
      } catch (err) {
        console.error('[rentals] failed to update item status on rental status change', err);
      }
    }

    await rental.save();
    const populatedRental = await Rental.findById(rental._id).populate('item customer');
    res.json(populatedRental);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// DELETE /api/rentals/:id
exports.deleteRental = async (req, res) => {
  try {
    // Find and populate to update counters if needed
    const rental = await Rental.findOne({ customId: req.params.id }).populate('item customer');
    if (!rental) return res.status(404).json({ error: 'Rental not found' });
    
    // Rollback counters and restore item availability when no open rentals remain.
    if (rental.item) {
      rental.item.timesRented = Math.max(0, rental.item.timesRented - 1);
      const remainingOpenRental = await Rental.findOne({
        _id: { $ne: rental._id },
        item: rental.item._id,
        status: { $in: [RentalStatus.ACTIVE, RentalStatus.UPCOMING] }
      });

      if (!remainingOpenRental) {
        rental.item.status = ItemStatus.AVAILABLE;
      } else if (remainingOpenRental.status === RentalStatus.ACTIVE) {
        rental.item.status = ItemStatus.RENTED;
      } else {
        rental.item.status = ItemStatus.RESERVED;
      }

      await rental.item.save();
    }
    if (rental.customer) {
      rental.customer.rentals = Math.max(0, rental.customer.rentals - 1);
      rental.customer.totalSpent = Math.max(0, rental.customer.totalSpent - rental.total);
      await rental.customer.save();
    }
    
    await Rental.findOneAndDelete({ customId: req.params.id });
    res.json({ message: 'Rental deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
