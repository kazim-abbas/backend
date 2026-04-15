const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { Agency, AdminSettings, User } = require('../models');
const tokenService = require('../services/token.service');

const getSettings = asyncHandler(async (req, res) => {
  const settings = await AdminSettings.getSingleton();
  res.json({ settings });
});

const updateSettings = asyncHandler(async (req, res) => {
  const settings = await AdminSettings.getSingleton();
  Object.assign(settings, req.body);
  // Merge features shallowly so partial updates don't wipe unspecified keys
  if (req.body.features) {
    settings.features = { ...settings.features, ...req.body.features };
  }
  await settings.save();
  res.json({ settings });
});

const listAgencies = asyncHandler(async (req, res) => {
  const agencies = await Agency.find().sort({ created_at: -1 }).lean();
  res.json({ agencies });
});

const getAgency = asyncHandler(async (req, res) => {
  const agency = await Agency.findById(req.params.id);
  if (!agency) throw AppError.notFound('Agency not found');
  res.json({ agency });
});

const createAgency = asyncHandler(async (req, res) => {
  const slug = slugify(req.body.name);
  const existing = await Agency.findOne({ slug });
  if (existing) throw AppError.conflict('Agency slug already exists');
  const agency = await Agency.create({ ...req.body, slug });
  res.status(201).json({ agency });
});

const updateAgency = asyncHandler(async (req, res) => {
  const agency = await Agency.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!agency) throw AppError.notFound('Agency not found');
  res.json({ agency });
});

/**
 * Global usage dashboard. Honors `?since=ISO` for time windowing and
 * `?agency_id=...` to scope to one tenant.
 */
const usageSummary = asyncHandler(async (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : null;
  const agency_id = req.query.agency_id || null;
  const summary = await tokenService.getUsageSummary({ agency_id, since });
  res.json(summary);
});

const listUsers = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.agency_id) filter.agency_id = req.query.agency_id;
  if (req.query.role) filter.role = req.query.role;
  const users = await User.find(filter).sort({ created_at: -1 }).lean();
  res.json({ users: users.map((u) => ({ ...u, password_hash: undefined })) });
});

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

module.exports = {
  getSettings,
  updateSettings,
  listAgencies,
  getAgency,
  createAgency,
  updateAgency,
  usageSummary,
  listUsers,
};
