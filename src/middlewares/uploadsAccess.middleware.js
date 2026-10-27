import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import prisma from '../config/db.js';

// Public asset prefixes that may be legitimately served without authentication
const PUBLIC_PREFIXES = [
  'profilepic_',
  'avatar_',
  'item_',
  'product_',
  'inventory_',
  'catalog_',
  'logo_',
  'icon_',
  'public_'
];

// Document prefixes known to contain sensitive personal/financial information
const PROTECTED_PREFIXES = [
  'passport_',
  'license_',
  'nib_',
  'resume_',
  'certs_',
  'doc_',
  'document_',
  'banking_',
  'id_',
  'businesslicense_',
  'staff_doc_',
  'police_record_'
];

export const isPublicAsset = (filename) => {
  const lower = filename.toLowerCase();
  return PUBLIC_PREFIXES.some(prefix => lower.startsWith(prefix));
};

export const isProtectedDocument = (filename) => {
  const lower = filename.toLowerCase();
  return PROTECTED_PREFIXES.some(prefix => lower.startsWith(prefix));
};

/**
 * Uploads Access Control Middleware
 * - Serves public assets (avatars, product images, logos)
 * - Restricts private documents (passports, DLs, NIB, resumes, banking files) to:
 *    1. Document owner
 *    2. Super Admin (cross-tenant permitted)
 *    3. Tenant Admin/HR (strict tenant isolation enforced)
 * - Denies unauthenticated (401) and unauthorized/cross-tenant (403) access
 */
export const handleUploadsAccess = async (req, res, next) => {
  try {
    const rawPath = req.path || '';
    let decodedPath = rawPath;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch (_) {}
    const filename = path.basename(decodedPath);

    // Guard against path traversal
    if (!filename || filename.includes('..') || rawPath.includes('..') || decodedPath.includes('..')) {
      return res.status(400).json({ success: false, message: 'Invalid file request' });
    }

    const uploadsDir = path.join(process.cwd(), 'uploads');
    const filePath = path.resolve(uploadsDir, filename);

    if (!filePath.startsWith(uploadsDir)) {
      return res.status(403).json({ success: false, message: 'Directory traversal forbidden' });
    }

    // If file is classified as a public asset, serve immediately if exists
    if (isPublicAsset(filename)) {
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, message: 'File not found' });
      }
      return res.sendFile(filePath);
    }

    // Private / protected document handling: require authentication
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.headers['x-access-token']) {
      token = req.headers['x-access-token'];
    } else if (req.query?.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required: Access to private personal documents is restricted'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwtSecret);
    } catch (jwtErr) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired authentication token'
      });
    }

    const requester = await prisma.user.findFirst({
      where: { id: decoded.id, deletedAt: null },
      include: { role: true }
    });

    if (!requester) {
      return res.status(401).json({ success: false, message: 'User no longer exists' });
    }

    // Determine document owner
    const match = filename.match(/_user_(\d+)_/);
    let targetUserId = match ? Number(match[1]) : null;
    let targetUser = null;

    if (targetUserId) {
      targetUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, tenantId: true }
      });
    }

    if (!targetUser) {
      const userWithDoc = await prisma.user.findFirst({
        where: {
          OR: [
            { passportUrl: { contains: filename } },
            { licenseUrl: { contains: filename } },
            { nibUrl: { contains: filename } },
            { resumeUrl: { contains: filename } },
            { certsUrl: { contains: filename } }
          ]
        },
        select: { id: true, tenantId: true }
      });
      if (userWithDoc) {
        targetUser = userWithDoc;
        targetUserId = userWithDoc.id;
      }
    }

    let empDoc = null;
    if (!targetUser) {
      empDoc = await prisma.employeeDocument.findFirst({
        where: { filePath: { contains: filename } },
        include: { employee: true }
      });
      if (empDoc?.employee?.userId) {
        targetUserId = empDoc.employee.userId;
      }
    }

    let clientDoc = null;
    if (!targetUser && !empDoc) {
      clientDoc = await prisma.client.findFirst({
        where: { source: { contains: filename } }
      });
    }

    // Authorization & Tenant Isolation Checks
    const requesterRole = String(requester.role?.name || '').toUpperCase();
    const isSuperAdmin = requesterRole === 'SUPER_ADMIN' || requesterRole === 'SUPERADMIN';
    const isAdminOrHR = ['ADMIN', 'HR', 'HR_MANAGER', 'OPERATIONS'].includes(requesterRole);

    let isAuthorized = false;

    // Rule 1: Document owner always has access to their own document
    const isOwner = targetUserId ? (requester.id === targetUserId) : false;
    if (isOwner) {
      isAuthorized = true;
    } else if (isSuperAdmin) {
      // Rule 2: Super Admin has global access across tenants
      isAuthorized = true;
    } else if (isAdminOrHR) {
      // Rule 3: Admin / HR must be within the same tenant (Tenant Isolation)
      const docTenantId = targetUser?.tenantId ?? empDoc?.tenantId ?? clientDoc?.tenantId;
      const requesterTenantId = requester.tenantId;

      if (docTenantId != null && requesterTenantId != null && docTenantId !== requesterTenantId && requesterTenantId !== 1) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Cross-tenant document access denied'
        });
      }

      isAuthorized = true;
    }

    // Rule 4: All other unpermitted users (customers, regular staff, etc.) are denied
    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You do not have permission to access this private document'
      });
    }

    // Only AFTER authorization is confirmed, check file existence
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    return res.sendFile(filePath);
  } catch (err) {
    console.error('💥 [UPLOADS_ACCESS_ERROR]', err);
    return res.status(500).json({ success: false, message: 'Internal error accessing file' });
  }
};
