const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { Ticket } = require('../models');

/**
 * List tickets. Always spreads `req.tenantFilter` to enforce agency isolation.
 */
const list = asyncHandler(async (req, res) => {
  const { status, search, page, limit } = req.query;

  const filter = { ...req.tenantFilter };
  if (status) filter.status = status;
  if (search) {
    filter.$or = [
      { subject: { $regex: search, $options: 'i' } },
      { 'messages.text': { $regex: search, $options: 'i' } },
    ];
  }

  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Ticket.find(filter)
      .sort({ last_message_at: -1 })
      .skip(skip)
      .limit(limit)
      .select('-messages')
      .lean(),
    Ticket.countDocuments(filter),
  ]);

  res.json({
    items,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
    },
  });
});

const getById = asyncHandler(async (req, res) => {
  const ticket = await Ticket.findOne({
    _id: req.params.id,
    ...req.tenantFilter,
  }).lean();
  if (!ticket) throw AppError.notFound('Ticket not found');
  res.json({ ticket });
});

const updateStatus = asyncHandler(async (req, res) => {
  const ticket = await Ticket.findOneAndUpdate(
    { _id: req.params.id, ...req.tenantFilter },
    {
      status: req.body.status,
      ...(req.body.status === 'resolved' ? { resolved_at: new Date() } : {}),
    },
    { new: true }
  );
  if (!ticket) throw AppError.notFound('Ticket not found');
  res.json({ ticket });
});

/**
 * Agent reply posted from the dashboard. Appended to messages with
 * sender=agent. Note: this does NOT push to Intercom; pushing would be a
 * follow-up using the Intercom Admin Reply API.
 */
const reply = asyncHandler(async (req, res) => {
  const ticket = await Ticket.findOne({
    _id: req.params.id,
    ...req.tenantFilter,
  });
  if (!ticket) throw AppError.notFound('Ticket not found');

  ticket.messages.push({
    sender: 'agent',
    sender_id: req.user._id.toString(),
    sender_name: req.user.name || req.user.email,
    text: req.body.text,
    timestamp: new Date(),
  });
  ticket.last_message_at = new Date();
  await ticket.save();

  res.json({ ticket });
});

module.exports = { list, getById, updateStatus, reply };
