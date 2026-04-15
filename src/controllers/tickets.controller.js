const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { Ticket, Agency } = require('../models');
const intercomService = require('../services/intercom.service');
const emailService = require('../services/email.service');
const logger = require('../utils/logger');

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
  // Load-then-save (instead of findOneAndUpdate) so we can compare the
  // previous status. We specifically need to know if this PATCH is the
  // one that flipped the ticket into "closed" — that's when the transcript
  // email should fire, and exactly once per ticket lifecycle.
  const ticket = await Ticket.findOne({
    _id: req.params.id,
    ...req.tenantFilter,
  });
  if (!ticket) throw AppError.notFound('Ticket not found');

  const prevStatus = ticket.status;
  const newStatus = req.body.status;
  const isNewlyClosed = newStatus === 'closed' && !ticket.closed_at;

  ticket.status = newStatus;
  if (newStatus === 'resolved' && !ticket.resolved_at) {
    ticket.resolved_at = new Date();
  }
  if (isNewlyClosed) {
    ticket.closed_at = new Date();
  }
  await ticket.save();

  // Mirror the status change to Intercom. Fire-and-forget: a local success
  // is what the user cares about; we just log sync failures.
  if (ticket.intercom_conversation_id && prevStatus !== newStatus) {
    intercomService
      .syncStatusToIntercom({
        conversationId: ticket.intercom_conversation_id,
        dashboardStatus: ticket.status,
      })
      .then((result) => {
        if (!result.ok) {
          logger.warn('intercom_status_sync_failed', {
            ticket_id: ticket._id.toString(),
            reason: result.reason || result.status,
          });
        }
      })
      .catch((err) =>
        logger.error('intercom_status_sync_threw', { error: err.message })
      );
  }

  // Transcript email: only on the transition into "closed", never on a
  // repeat PATCH or on resolved→closed bounce. Fire-and-forget so a slow
  // mail provider can't stall the API response.
  if (isNewlyClosed) {
    const agency = req.agency || (await Agency.findById(ticket.agency_id).catch(() => null));
    emailService
      .sendClosedTicketTranscript({ agency, ticket })
      .then((result) => {
        if (result?.sent) {
          logger.info('closed_ticket_transcript_sent', {
            ticket_id: ticket._id.toString(),
            to: agency?.contact_email,
            id: result.id,
          });
        } else if (result?.skipped) {
          logger.warn('closed_ticket_transcript_skipped', {
            ticket_id: ticket._id.toString(),
            reason: result.reason,
          });
        } else if (result?.sent === false) {
          logger.error('closed_ticket_transcript_failed', {
            ticket_id: ticket._id.toString(),
            error: result.error,
          });
        }
      })
      .catch((err) =>
        logger.error('closed_ticket_transcript_threw', {
          ticket_id: ticket._id.toString(),
          error: err.message,
        })
      );
  }

  res.json({ ticket });
});

/**
 * Agent reply posted from the dashboard.
 * 1. Append to local ticket messages (sender=agent).
 * 2. Push to Intercom as an admin reply so the end user sees it in Messenger.
 */
const reply = asyncHandler(async (req, res) => {
  const ticket = await Ticket.findOne({
    _id: req.params.id,
    ...req.tenantFilter,
  });
  if (!ticket) throw AppError.notFound('Ticket not found');

  // Push to Intercom first so we can capture the returned part id and
  // stamp it on the local message. This prevents the echo webhook from
  // re-adding the same reply as a duplicate.
  let intercomPartId = '';
  if (ticket.intercom_conversation_id) {
    const result = await intercomService.sendAdminReplyToIntercom({
      conversationId: ticket.intercom_conversation_id,
      body: req.body.text,
    });
    if (result.ok) {
      // The reply endpoint returns the whole conversation; the newest part is
      // the reply we just posted.
      const parts =
        result.json?.conversation_parts?.conversation_parts ||
        result.json?.conversation_parts ||
        [];
      intercomPartId = parts[parts.length - 1]?.id || '';
    } else {
      logger.warn('intercom_reply_sync_failed', {
        ticket_id: ticket._id.toString(),
        reason: result.reason || result.status,
      });
    }
  }

  ticket.messages.push({
    sender: 'agent',
    sender_id: req.user._id.toString(),
    sender_name: req.user.name || req.user.email,
    text: req.body.text,
    intercom_part_id: intercomPartId,
    timestamp: new Date(),
  });
  ticket.last_message_at = new Date();
  await ticket.save();

  res.json({ ticket });
});

/**
 * Ticket stats for the current tenant.
 *
 * Returns:
 *   totals: { total, open, pending, resolved, closed }
 *   by_month: last 12 calendar months, each with the same status counts.
 *
 * All aggregation is scoped by req.tenantFilter so agency A never sees
 * agency B's counts; platform admins see everything (or a specific agency
 * if `?agency_id=...` was used upstream).
 */
const stats = asyncHandler(async (req, res) => {
  const now = new Date();
  // First day of the window: 12 months ago, at 00:00 UTC.
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));

  const match = { ...req.tenantFilter };

  const rows = await Ticket.aggregate([
    { $match: match },
    {
      $facet: {
        totals: [
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ],
        by_month: [
          { $match: { created_at: { $gte: windowStart } } },
          {
            $group: {
              _id: {
                year: { $year: '$created_at' },
                month: { $month: '$created_at' },
                status: '$status',
              },
              count: { $sum: 1 },
            },
          },
        ],
      },
    },
  ]);

  const facet = rows[0] || { totals: [], by_month: [] };

  // Flatten totals.
  const totals = { total: 0, open: 0, pending: 0, resolved: 0, closed: 0 };
  for (const row of facet.totals) {
    if (row._id && totals[row._id] !== undefined) totals[row._id] = row.count;
    totals.total += row.count;
  }

  // Build a 12-slot month skeleton so empty months still show up as zeros.
  const byMonthMap = new Map();
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    byMonthMap.set(key, {
      month: key,
      total: 0,
      open: 0,
      pending: 0,
      resolved: 0,
      closed: 0,
    });
  }
  for (const row of facet.by_month) {
    const key = `${row._id.year}-${String(row._id.month).padStart(2, '0')}`;
    const bucket = byMonthMap.get(key);
    if (!bucket) continue; // rows outside our 12-month window
    if (bucket[row._id.status] !== undefined) {
      bucket[row._id.status] = row.count;
    }
    bucket.total += row.count;
  }

  res.json({
    totals,
    by_month: Array.from(byMonthMap.values()),
  });
});

module.exports = { list, getById, updateStatus, reply, stats };
