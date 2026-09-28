import * as supportService from '../services/support.service.js';
import { sendResponse } from '../utils/response.js';
import { emitToTenant } from '../utils/socket.js';
import cloudinary from '../config/cloudinary.js';

import { resolveTenantId } from '../utils/tenantResolver.js';
const handleRequest = async (req, res, next, serviceFn, successMsg, eventName) => {
  try {
    const roleName = String(typeof req.user?.role === 'string' ? req.user.role : (req.user?.role?.name || '')).toUpperCase();
    const isSuperAdminOrAdmin = ['SUPER_ADMIN', 'SUPERADMIN', 'ADMIN'].includes(roleName) && (Number(req.user.tenantId) === 1 || !req.user.tenantId);
    let tenantId;
    
    if (req.method === 'GET') {
      tenantId = resolveTenantId(req);
      const result = await serviceFn(tenantId, req.user);
      sendResponse(res, 200, successMsg, result);
    } else if (req.method === 'POST') {
      tenantId = isSuperAdminOrAdmin ? (req.body.tenantId || req.user.tenantId || 1) : (req.user.tenantId || 1);
      const result = await serviceFn(req.body, req.user.id, tenantId);
      if (eventName) emitToTenant(result.tenantId || tenantId, eventName, result);
      sendResponse(res, 201, successMsg, result);
    } else if (req.method === 'PUT') {
      tenantId = isSuperAdminOrAdmin ? null : resolveTenantId(req);
      const result = await serviceFn(req.params.id, req.body, tenantId, req.user.id);
      if (eventName) emitToTenant(result.tenantId || tenantId || req.user.tenantId, eventName, result);
      sendResponse(res, 200, successMsg, result);
    } else if (req.method === 'DELETE') {
      tenantId = isSuperAdminOrAdmin ? null : resolveTenantId(req);
      await serviceFn(req.params.id, tenantId, req.user.id);
      if (eventName) emitToTenant(tenantId || req.user.tenantId, eventName, { id: req.params.id, deleted: true });
      sendResponse(res, 200, successMsg, null);
    }
  } catch (error) {
    next(error);
  }
};

// Attachments
export const uploadAttachment = async (req, res, next) => {
  try {
    if (!req.file) {
      return sendResponse(res, 400, 'No attachment file provided');
    }
    const baseFolder = process.env.CLOUDINARY_FOLDER || 'zanezion';
    const uploadStream = () => {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: `${baseFolder}/support`, resource_type: 'auto' },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        );
        stream.end(req.file.buffer);
      });
    };
    const result = await uploadStream();
    sendResponse(res, 200, 'Attachment uploaded to Cloudinary', { url: result.secure_url });
  } catch (error) {
    next(error);
  }
};

// Tickets
export const createTicket = (req, res, next) => handleRequest(req, res, next, supportService.createTicket, 'Ticket created', 'support_update');
export const getTickets = (req, res, next) => handleRequest(req, res, next, supportService.getTickets, 'Tickets fetched');
export const getTicketById = async (req, res, next) => {
  try {
    const roleName = String(typeof req.user?.role === 'string' ? req.user.role : (req.user?.role?.name || '')).toUpperCase();
    const isSuperAdminOrAdmin = ['SUPER_ADMIN', 'SUPERADMIN', 'ADMIN'].includes(roleName) && (Number(req.user.tenantId) === 1 || !req.user.tenantId);
    const tenantId = isSuperAdminOrAdmin ? null : resolveTenantId(req);
    const result = await supportService.getTicketById(req.params.id, tenantId, req.user);
    sendResponse(res, 200, 'Ticket details fetched', result);
  } catch (error) {
    next(error);
  }
};
export const updateTicket = (req, res, next) => handleRequest(req, res, next, supportService.updateTicket, 'Ticket updated', 'support_update');
export const updateTicketStatus = (req, res, next) => handleRequest(req, res, next, supportService.updateTicket, 'Ticket updated', 'support_update');
export const deleteTicket = (req, res, next) => handleRequest(req, res, next, supportService.deleteTicket, 'Ticket deleted', 'support_update');

// Events
export const createEvent = (req, res, next) => handleRequest(req, res, next, supportService.createEvent, 'Event created', 'event_update');
export const getEvents = (req, res, next) => handleRequest(req, res, next, supportService.getEvents, 'Events fetched');
export const updateEvent = (req, res, next) => handleRequest(req, res, next, supportService.updateEvent, 'Event updated', 'event_update');
export const deleteEvent = (req, res, next) => handleRequest(req, res, next, supportService.deleteEvent, 'Event deleted', 'event_update');

// Guest Requests
export const createGuestRequest = (req, res, next) => handleRequest(req, res, next, supportService.createGuestRequest, 'Request logged', 'guest_request_update');
export const getGuestRequests = (req, res, next) => handleRequest(req, res, next, supportService.getGuestRequests, 'Requests fetched');
export const updateGuestRequest = (req, res, next) => handleRequest(req, res, next, supportService.updateGuestRequest, 'Request updated', 'guest_request_update');
export const deleteGuestRequest = (req, res, next) => handleRequest(req, res, next, supportService.deleteGuestRequest, 'Request deleted', 'guest_request_update');
