import * as supportRepository from '../repositories/support.repository.js';
import AppError from '../utils/AppError.js';
import { logAudit } from '../utils/audit.js';
import cloudinary from '../config/cloudinary.js';

const generateId = (prefix) => `${prefix}-${Math.floor(1000 + Math.random() * 8999)}`;

const sanitizeAndUploadMessages = async (messages) => {
  if (!Array.isArray(messages)) return messages;
  const baseFolder = process.env.CLOUDINARY_FOLDER || 'zanezion';
  
  const processed = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') {
      processed.push(msg);
      continue;
    }
    const newMsg = { ...msg };
    if (newMsg.attachments && typeof newMsg.attachments === 'object') {
      const newAttachments = { ...newMsg.attachments };
      for (const [key, val] of Object.entries(newAttachments)) {
        if (typeof val === 'string' && val.startsWith('data:')) {
          try {
            const uploadRes = await cloudinary.uploader.upload(val, {
              folder: `${baseFolder}/support/messages`,
              resource_type: 'auto'
            });
            if (uploadRes?.secure_url) {
              newAttachments[key] = uploadRes.secure_url;
            }
          } catch (uploadErr) {
            console.warn(`[CLOUDINARY_AUTO_UPLOAD_WARN] Could not upload attachment ${key}:`, uploadErr?.message);
          }
        }
      }
      newMsg.attachments = newAttachments;
    }
    processed.push(newMsg);
  }
  return processed;
};

// Tickets
export const createTicket = async (data, performerId, tenantId) => {
  let ticketId = data.ticketId || data.id;
  if (!ticketId || String(ticketId).trim() === '') {
    ticketId = generateId('TKT');
  }
  let existing = await supportRepository.findTicketById(ticketId, tenantId);
  while (existing) {
    ticketId = `TKT-${Math.floor(1000 + Math.random() * 8999)}`;
    existing = await supportRepository.findTicketById(ticketId, tenantId);
  }

  const payload = {
    ticketId,
    title: data.subject || data.title || data.issue || 'Support Request',
    description: data.description || '',
    priority: data.priority || 'Medium',
    status: data.status || 'Open',
    category: data.category || 'General',
    clientId: (() => {
      const cid = data.client_id || data.clientId;
      if (!cid) return null;
      const parsed = parseInt(String(cid).replace(/\D/g, ''), 10);
      return isNaN(parsed) ? null : parsed;
    })(),
    managerId: data.manager_id ? Number(data.manager_id) : (data.managerId ? Number(data.managerId) : null),
    createdById: data.created_by ? Number(data.created_by) : (data.createdById ? Number(data.createdById) : null),
    createdByEmail: data.createdByEmail || null,
    createdByName: data.createdByName || null,
    messages: await sanitizeAndUploadMessages(data.messages ? JSON.parse(JSON.stringify(data.messages)) : []),
    tenantId
  };

  const ticket = await supportRepository.createTicket(payload);
  await logAudit({ module: 'SUPPORT', action: 'CREATE', description: `Logged ticket ${ticket.ticketId}`, newValue: ticket, performedBy: performerId });
  return { ...ticket, id: ticket.ticketId, ticketId: ticket.ticketId, db_id: ticket.id };
};

export const getTickets = async (tenantId, user) => {
  const roleName = typeof user?.role === 'object' ? (user?.role?.name || '') : String(user?.role || '');
  const normalizedRole = roleName.toLowerCase().replace(/\s+/g, '_');
  const userTenant = user?.tenantId ? Number(user.tenantId) : 1;
  const isHQStaff = ['super_admin', 'superadmin', 'admin', 'concierge', 'operations', 'logistics', 'procurement', 'inventory', 'staff'].includes(normalizedRole) && userTenant === 1;
  const effectiveTenantId = isHQStaff ? null : tenantId;
  const tickets = await supportRepository.findAllTickets(effectiveTenantId);

  if (['customer', 'individual_client', 'personal'].some(r => normalizedRole.includes(r))) {
    const myUserId = user?.id;
    const myEmail = String(user?.email || '').toLowerCase().trim();
    const myClientId = user?.clientId;
    return tickets
      .filter(t => (myUserId && t.createdById === myUserId) || (myEmail && t.createdByEmail?.toLowerCase().trim() === myEmail) || (myClientId && t.clientId === myClientId))
      .map(t => ({ ...t, id: t.ticketId, ticketId: t.ticketId, db_id: t.id }));
  }

  return tickets.map(t => ({ ...t, id: t.ticketId, ticketId: t.ticketId, db_id: t.id }));
};

export const getTicketById = async (id, tenantId, user) => {
  const roleName = typeof user?.role === 'object' ? (user?.role?.name || '') : String(user?.role || '');
  const normalizedRole = roleName.toLowerCase().replace(/\s+/g, '_');
  const userTenant = user?.tenantId ? Number(user.tenantId) : 1;
  const isHQStaff = ['super_admin', 'superadmin', 'admin', 'concierge', 'operations', 'logistics', 'procurement', 'inventory', 'staff'].includes(normalizedRole) && userTenant === 1;
  const effectiveTenantId = isHQStaff ? null : tenantId;

  const ticket = await supportRepository.findTicketById(id, effectiveTenantId);
  if (!ticket) throw new AppError('Ticket not found', 404);

  if (['customer', 'individual_client', 'personal'].some(r => normalizedRole.includes(r))) {
    const myUserId = user?.id;
    const myEmail = String(user?.email || '').toLowerCase().trim();
    const myClientId = user?.clientId;
    const isOwner = (myUserId && ticket.createdById === myUserId) ||
                    (myEmail && ticket.createdByEmail?.toLowerCase().trim() === myEmail) ||
                    (myClientId && ticket.clientId === myClientId);
    if (!isOwner) {
      throw new AppError('Access denied to this ticket', 403);
    }
  }

  let parsedMessages = ticket.messages;
  if (typeof parsedMessages === 'string') {
    try { parsedMessages = JSON.parse(parsedMessages); } catch (_) { parsedMessages = []; }
  }

  return {
    ...ticket,
    id: ticket.ticketId,
    ticketId: ticket.ticketId,
    db_id: ticket.id,
    messages: parsedMessages
  };
};

export const updateTicket = async (id, data, tenantId, performerId) => {
  // Allow admin updates across all tenants (tenantId null)
  const existing = await supportRepository.findTicketById(id, null);
  if (!existing) throw new AppError('Ticket not found', 404);

  const rawMessages = data.messages !== undefined ? data.messages : (data.responses !== undefined ? data.responses : existing.messages);
  let parsedMessages = rawMessages;
  if (typeof rawMessages === 'string') {
    try { parsedMessages = JSON.parse(rawMessages); } catch (_) { parsedMessages = []; }
  }

  const payload = {
    title: data.title !== undefined ? data.title : (data.subject !== undefined ? data.subject : existing.title),
    description: data.description !== undefined ? data.description : existing.description,
    priority: data.priority !== undefined ? data.priority : existing.priority,
    status: data.status !== undefined ? data.status : existing.status,
    category: data.category !== undefined ? data.category : existing.category,
    messages: await sanitizeAndUploadMessages(parsedMessages)
  };

  const updated = await supportRepository.updateTicket(id, null, payload);
  await logAudit({ module: 'SUPPORT', action: 'UPDATE', description: `Updated ticket ${id}`, oldValue: existing, newValue: updated, performedBy: performerId });
  return { ...updated, id: updated.ticketId, ticketId: updated.ticketId, db_id: updated.id };
};

export const deleteTicket = async (id, tenantId, performerId) => {
  let existing = await supportRepository.findTicketById(id, tenantId);
  if (!existing) {
    existing = await supportRepository.findTicketById(id, null);
  }
  if (!existing) throw new AppError('Ticket not found', 404);
  await supportRepository.deleteTicket(id, null);
  await logAudit({ module: 'SUPPORT', action: 'DELETE', description: `Deleted ticket ${id}`, oldValue: existing, performedBy: performerId });
  return true;
};

// Events
export const createEvent = async (data, performerId, tenantId) => {
  let eventId = data.id || generateId('EVT');
  const existing = await supportRepository.findEventById(eventId, tenantId);
  if (existing) throw new AppError('Event ID already exists', 400);

  const parsedCid = data.client_id ? Number(String(data.client_id).replace('CLT-', '')) : null;
  const clientId = Number.isFinite(parsedCid) && parsedCid > 0 ? parsedCid : null;

  let moodBoardUrl = (data.mood_board_url || data.moodBoardUrl || '').trim();
  if (moodBoardUrl && !moodBoardUrl.startsWith('http://') && !moodBoardUrl.startsWith('https://')) {
    moodBoardUrl = `https://${moodBoardUrl}`;
  }

  const user = performerId ? await prisma.user.findUnique({ where: { id: Number(performerId) } }) : null;
  const resolvedPlanner = data.planner_name || data.plannerName || (data.client && data.client.toLowerCase() !== 'personal client' ? data.client : null) || user?.name || '';

  const payload = {
    eventId,
    name: data.name || data.title || 'Support Event',
    date: data.date || data.event_date || '',
    location: data.location || '',
    status: data.status || 'Scheduled',
    clientId,
    managerId: data.manager_id && !isNaN(Number(data.manager_id)) ? Number(data.manager_id) : null,
    specialRequests: data.special_requests || '',
    plannerName: resolvedPlanner,
    guestCount: data.guest_count ? Number(data.guest_count) : null,
    moodBoardUrl,
    tenantId
  };

  const event = await supportRepository.createEvent(payload);
  return { ...event, id: event.eventId, db_id: event.id };
};

export const getEvents = async (tenantId, user) => {
  const roleName = typeof user?.role === 'object' ? (user?.role?.name || '') : String(user?.role || '');
  const normalizedRole = roleName.toLowerCase().replace(/\s+/g, '_');
  const userTenant = user?.tenantId ? Number(user.tenantId) : 1;
  const isHQStaff = ['super_admin', 'superadmin', 'admin', 'concierge', 'operations', 'logistics', 'procurement', 'inventory', 'staff'].includes(normalizedRole) && userTenant === 1;
  const effectiveTenantId = isHQStaff ? null : tenantId;
  const events = await supportRepository.findAllEvents(effectiveTenantId);

  if (['customer', 'individual_client', 'personal'].some(r => normalizedRole.includes(r))) {
    const myUserId = user?.id;
    const myEmail = String(user?.email || '').toLowerCase().trim();
    const myClientId = user?.clientId;
    return events
      .filter(e => (myClientId && e.clientId === myClientId) || (myEmail && e.client?.email?.toLowerCase().trim() === myEmail) || (myUserId && e.managerId === myUserId) || (e.tenantId && e.tenantId === user?.tenantId))
      .map(e => ({ ...e, id: e.eventId, db_id: e.id }));
  }

  return events.map(e => ({ ...e, id: e.eventId, db_id: e.id }));
};

export const updateEvent = async (id, data, tenantId, performerId) => {
  let existing = await supportRepository.findEventById(id, tenantId);
  if (!existing && tenantId !== null) {
    existing = await supportRepository.findEventById(id, null);
  }
  if (!existing) throw new AppError('Event not found', 404);

  let updatedMoodBoard = data.mood_board_url !== undefined ? data.mood_board_url : (data.moodBoardUrl !== undefined ? data.moodBoardUrl : existing.moodBoardUrl);
  if (typeof updatedMoodBoard === 'string' && updatedMoodBoard.trim() && !updatedMoodBoard.trim().startsWith('http://') && !updatedMoodBoard.trim().startsWith('https://')) {
    updatedMoodBoard = `https://${updatedMoodBoard.trim()}`;
  }

  const updatedCid = data.client_id !== undefined ? (data.client_id ? Number(String(data.client_id).replace('CLT-', '')) : null) : existing.clientId;
  const clientId = Number.isFinite(updatedCid) && updatedCid > 0 ? updatedCid : null;

  const payload = {
    name: data.name !== undefined ? data.name : (data.title !== undefined ? data.title : existing.name),
    date: data.date !== undefined ? data.date : (data.event_date !== undefined ? data.event_date : existing.date),
    location: data.location !== undefined ? data.location : existing.location,
    status: data.status !== undefined ? data.status : existing.status,
    clientId,
    managerId: data.manager_id !== undefined ? (data.manager_id ? Number(data.manager_id) : null) : existing.managerId,
    specialRequests: data.special_requests !== undefined ? data.special_requests : existing.specialRequests,
    plannerName: data.planner_name !== undefined ? data.planner_name : existing.plannerName,
    guestCount: data.guest_count !== undefined ? (data.guest_count ? Number(data.guest_count) : null) : existing.guestCount,
    moodBoardUrl: updatedMoodBoard
  };

  const updated = await supportRepository.updateEvent(id, tenantId, payload);
  return { ...updated, id: updated.eventId, db_id: updated.id };
};

export const deleteEvent = async (id, tenantId, performerId) => {
  let existing = await supportRepository.findEventById(id, tenantId);
  if (!existing && tenantId !== null) {
    existing = await supportRepository.findEventById(id, null);
  }
  if (!existing) throw new AppError('Event not found', 404);
  await supportRepository.deleteEvent(id, existing.tenantId ?? tenantId);
  return true;
};

// Guest Requests
export const createGuestRequest = async (data, performerId, tenantId) => {
  let requestId = data.id || generateId('GRQ');
  const existing = await supportRepository.findGuestRequestById(requestId, tenantId);
  if (existing) throw new AppError('Guest Request ID already exists', 400);

  const payload = {
    ...data,
    requestId,
    guestName: data.guestName || data.guest || data.name || 'Guest',
    room: data.room || '',
    requestType: data.requestType || data.type || 'General',
    status: data.status || 'Pending',
    created_by: performerId,
    tenantId
  };

  const req = await supportRepository.createGuestRequest(payload);
  return { ...req, id: req.requestId, db_id: req.id };
};

export const getGuestRequests = async (tenantId, user) => {
  const roleName = typeof user?.role === 'object' ? (user?.role?.name || '') : String(user?.role || '');
  const normalizedRole = roleName.toLowerCase().replace(/\s+/g, '_');
  const userTenant = user?.tenantId ? Number(user.tenantId) : 1;
  const isHQStaff = ['super_admin', 'superadmin', 'admin', 'concierge', 'operations', 'logistics', 'procurement', 'inventory', 'staff'].includes(normalizedRole) && userTenant === 1;
  const effectiveTenantId = isHQStaff ? null : tenantId;
  const reqs = await supportRepository.findAllGuestRequests(effectiveTenantId);

  if (['customer', 'individual_client', 'personal'].some(r => normalizedRole.includes(r))) {
    const myUserId = String(user?.id);
    return reqs
      .filter(r => String(r.created_by) === myUserId || String(r.userId) === myUserId || String(r.user_id) === myUserId || (r.tenantId && r.tenantId === user?.tenantId))
      .map(r => ({ ...r, id: r.requestId, db_id: r.id }));
  }

  return reqs.map(r => ({ ...r, id: r.requestId, db_id: r.id }));
};

export const updateGuestRequest = async (id, data, tenantId, performerId) => {
  let existing = await supportRepository.findGuestRequestById(id, tenantId);
  if (!existing && tenantId !== null) {
    existing = await supportRepository.findGuestRequestById(id, null);
  }
  if (!existing) throw new AppError('Guest Request not found', 404);
  
  if (data.guest && !data.guestName) data.guestName = data.guest;

  const updated = await supportRepository.updateGuestRequest(id, existing.tenantId ?? tenantId, data);
  return { ...updated, id: updated.requestId, db_id: updated.id };
};

export const deleteGuestRequest = async (id, tenantId, performerId) => {
  let existing = await supportRepository.findGuestRequestById(id, tenantId);
  if (!existing && tenantId !== null) {
    existing = await supportRepository.findGuestRequestById(id, null);
  }
  if (!existing) throw new AppError('Guest Request not found', 404);
  await supportRepository.deleteGuestRequest(id, existing.tenantId ?? tenantId);
  return true;
};
