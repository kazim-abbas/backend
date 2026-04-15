const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { Ticket, Agency } = require('../models');
const aiService = require('../services/ai.service');

async function loadScopedTicket(ticket_id, req) {
  const filter = { _id: ticket_id, ...req.tenantFilter };
  const ticket = await Ticket.findOne(filter);
  if (!ticket) throw AppError.notFound('Ticket not found');

  // Agency context: for admins viewing cross-tenant, look up the ticket's agency.
  const agency = req.agency || (await Agency.findById(ticket.agency_id));
  if (!agency) throw AppError.notFound('Agency not found');

  return { ticket, agency };
}

const reply = asyncHandler(async (req, res) => {
  const { ticket, agency } = await loadScopedTicket(req.body.ticket_id, req);
  const result = await aiService.generateAutoReply({ ticket, agency });
  res.json(result);
});

const summary = asyncHandler(async (req, res) => {
  const { ticket, agency } = await loadScopedTicket(req.body.ticket_id, req);
  const result = await aiService.generateSummary({ ticket, agency });
  res.json(result);
});

module.exports = { reply, summary };
