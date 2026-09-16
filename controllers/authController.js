const bcrypt = require('bcryptjs');
const User = require('../models/User');

function normalizePhone(input) {
  return String(input || '').trim();
}

// POST /api/auth/signup
exports.signup = async (req, res) => {
  try {
    const { name, phone, password, role, status, email, branch = 'Shop 1' } = req.body || {};

    if (!name || !phone || !password) {
      return res.status(400).json({ error: 'name, phone, and password are required' });
    }

    const normalizedPhone = normalizePhone(phone);

    // Prevent duplicate users
    const existingByPhone = await User.findOne({ phone: normalizedPhone });
    if (existingByPhone) {
      return res.status(409).json({ error: 'An account with this phone already exists' });
    }

    if (email) {
      const normalizedEmail = String(email).trim().toLowerCase();
      const existingByEmail = await User.findOne({ email: normalizedEmail });
      if (existingByEmail) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }
    }

    const passwordHash = await bcrypt.hash(String(password), 10);

    const user = new User({
      name: String(name).trim(),
      phone: normalizedPhone,
      email: email ? String(email).trim().toLowerCase() : undefined,
      passwordHash,
      rawPassword: String(password),
      role: ['admin', 'reception'].includes(role) ? role : 'employee',
      status: status === 'active' ? 'active' : 'pending',
      branch: branch || 'Shop 1',
    });

    await user.save();

    res.status(201).json({
      id: user._id,
      name: user.name,
      role: user.role,
      status: user.status,
      phone: user.phone,
      email: user.email,
      branch: user.branch || 'Shop 1',
      rawPassword: user.rawPassword,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// POST /api/auth/login
exports.login = async (req, res) => {
  try {
    const { email, phone, password, branch } = req.body || {};

    if ((!email && !phone) || !password) {
      return res.status(400).json({ error: 'email or phone and password are required' });
    }

    // Prefer phone if provided (frontend currently uses email, but signup uses phone)
    const query = email
      ? { email: String(email).trim().toLowerCase() }
      : { phone: normalizePhone(phone) };

    const user = await User.findOne(query);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials or account not found.' });
    }

    if (user.status === 'pending') {
      return res.status(403).json({ error: 'Your account is pending admin approval.' });
    }

    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials or account not found.' });
    }

    // Check if staff tries to access a different shop than assigned
    if (user.role !== 'admin' && branch && user.branch && branch !== user.branch) {
      return res.status(403).json({
        error: 'Correct the shop name. You are not able to access the other shop.'
      });
    }

    let needsSave = false;
    if (!user.rawPassword && password) {
      user.rawPassword = String(password);
      needsSave = true;
    }
    if (needsSave) {
      await user.save();
    }

    res.json({
      id: user._id,
      name: user.name,
      role: user.role,
      status: user.status,
      phone: user.phone,
      email: user.email,
      branch: user.branch || branch || 'Shop 1',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// GET /api/users
exports.getUsers = async (req, res) => {
  try {
    const { branch } = req.query;
    const query = {};
    if (branch) {
      if (branch === 'Shop 1') {
        query.$or = [{ branch: 'Shop 1' }, { branch: { $exists: false } }, { branch: null }, { branch: '' }];
      } else {
        query.branch = branch;
      }
    }
    const users = await User.find(query, { passwordHash: 0 }).sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// PUT /api/users/:identifier/status
exports.updateUserStatus = async (req, res) => {
  try {
    const { identifier } = req.params;
    const { status } = req.body;

    // Allow lookup by MongoDB _id, phone, or email
    const query = identifier.match(/^[0-9a-fA-F]{24}$/) 
      ? { _id: identifier } 
      : { $or: [{ phone: normalizePhone(identifier) }, { email: String(identifier).trim().toLowerCase() }] };

    const user = await User.findOneAndUpdate(query, { status }, { new: true });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'Status updated successfully', user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// PUT /api/users/:identifier/password
exports.updateUserPassword = async (req, res) => {
  try {
    const { identifier } = req.params;
    const { password } = req.body;

    if (!password || !String(password).trim()) {
      return res.status(400).json({ error: 'New password is required' });
    }

    const query = identifier.match(/^[0-9a-fA-F]{24}$/)
      ? { _id: identifier }
      : { $or: [{ phone: normalizePhone(identifier) }, { email: String(identifier).trim().toLowerCase() }] };

    const newPasswordStr = String(password).trim();
    const passwordHash = await bcrypt.hash(newPasswordStr, 10);

    const user = await User.findOneAndUpdate(
      query,
      { passwordHash, rawPassword: newPasswordStr },
      { new: true, select: '-passwordHash' }
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'Password updated successfully', user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// DELETE /api/users/:identifier
exports.deleteUser = async (req, res) => {
  try {
    const { identifier } = req.params;

    // Allow lookup by MongoDB _id, phone, or email
    const query = identifier.match(/^[0-9a-fA-F]{24}$/) 
      ? { _id: identifier } 
      : { $or: [{ phone: normalizePhone(identifier) }, { email: String(identifier).trim().toLowerCase() }] };

    const user = await User.findOneAndDelete(query);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
