import express from 'express';
import * as supportController from '../controllers/support.controller.js';
import { authenticate, checkPermission } from '../middlewares/auth.middleware.js';
import { upload } from '../middlewares/upload.middleware.js';

const router = express.Router();

router.use(authenticate);

// Attachments
router.post('/upload', upload.single('file'), supportController.uploadAttachment);

// Tickets
router.get('/tickets', checkPermission('SUPPORT', 'READ'), supportController.getTickets);
router.get('/tickets/:id', checkPermission('SUPPORT', 'READ'), supportController.getTicketById);
router.post('/tickets', checkPermission('SUPPORT', 'CREATE'), supportController.createTicket);
router.put('/tickets/:id', checkPermission('SUPPORT', 'UPDATE'), supportController.updateTicket);
router.delete('/tickets/:id', checkPermission('SUPPORT', 'DELETE'), supportController.deleteTicket);

// Events
router.get('/events', checkPermission('SUPPORT', 'READ'), supportController.getEvents);
router.post('/events', checkPermission('SUPPORT', 'CREATE'), supportController.createEvent);
router.put('/events/:id', checkPermission('SUPPORT', 'UPDATE'), supportController.updateEvent);
router.delete('/events/:id', checkPermission('SUPPORT', 'DELETE'), supportController.deleteEvent);

// Guest Requests
router.get('/guest-requests', checkPermission('SUPPORT', 'READ'), supportController.getGuestRequests);
router.post('/guest-requests', checkPermission('SUPPORT', 'CREATE'), supportController.createGuestRequest);
router.put('/guest-requests/:id', checkPermission('SUPPORT', 'UPDATE'), supportController.updateGuestRequest);
router.delete('/guest-requests/:id', checkPermission('SUPPORT', 'DELETE'), supportController.deleteGuestRequest);

export default router;
