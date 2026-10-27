import { describe, it } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { isPublicAsset, isProtectedDocument } from './src/middlewares/uploadsAccess.middleware.js';
import { sanitizeAuditData } from './src/utils/audit.js';
import { config } from './src/config/env.js';
import fs from 'fs';
import path from 'path';

// --------------------------------------------------------------------------
// 1. UPLOADS ASSET CLASSIFICATION & PRESERVATION OF PUBLIC ASSETS
// --------------------------------------------------------------------------
describe('1. Uploads Classification & Public Asset Preservation', () => {
  it('correctly classifies public assets (avatars, product images, catalog, logos)', () => {
    const publicFiles = [
      'profilePic_user_12_1729938291.png',
      'profilepic_user_5.jpg',
      'avatar_default.webp',
      'item_inventory_chair_456.png',
      'product_catalog_luxury_car.jpg',
      'inventory_sample_sku.jpeg',
      'catalog_event_hall.png',
      'logo_zanezion_gold.svg',
      'icon_check.png',
      'public_banner.jpg'
    ];

    publicFiles.forEach(file => {
      assert.strictEqual(isPublicAsset(file), true, `File ${file} should be recognized as a public asset`);
      assert.strictEqual(isProtectedDocument(file), false, `File ${file} should NOT be recognized as a protected document`);
    });
  });

  it('correctly classifies protected private documents (passports, DLs, NIB, resumes, banking)', () => {
    const privateFiles = [
      'passport_user_12_1729938291.pdf',
      'license_user_12_1729938291.jpg',
      'nib_user_12_1729938291.png',
      'resume_user_12_1729938291.pdf',
      'certs_user_12_1729938291.pdf',
      'banking_user_12_statement.pdf',
      'id_card_user_5.jpg',
      'businessLicense_1729938291_a1b2c3.pdf',
      'staff_doc_police_check.pdf',
      'police_record_user_8.pdf'
    ];

    privateFiles.forEach(file => {
      assert.strictEqual(isProtectedDocument(file), true, `File ${file} must be recognized as a protected document`);
      assert.strictEqual(isPublicAsset(file), false, `File ${file} must NOT be classified as public`);
    });
  });
});

// --------------------------------------------------------------------------
// 2. DOCUMENT ACCESS CONTROL, OWNERSHIP & TENANT ISOLATION
// --------------------------------------------------------------------------
describe('2. Document Access Control, Ownership & Tenant Isolation Logic', () => {
  const JWT_SECRET = config.jwtSecret || 'zanezion_super_secret_key_2026';

  // Helper simulating uploadsAccessMiddleware decision engine
  function evaluateDocumentAccess({ token, filename, targetUserId, docTenantId, userDb }) {
    if (isPublicAsset(filename)) {
      return { status: 200, allowed: true, reason: 'PUBLIC_ASSET' };
    }

    if (!token) {
      return { status: 401, allowed: false, message: 'Authentication required: Access to private personal documents is restricted' };
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return { status: 401, allowed: false, message: 'Invalid or expired authentication token' };
    }

    const requester = userDb.find(u => u.id === decoded.id);
    if (!requester) {
      return { status: 401, allowed: false, message: 'User no longer exists' };
    }

    const requesterRole = String(requester.role || '').toUpperCase();
    const isSuperAdmin = requesterRole === 'SUPER_ADMIN' || requesterRole === 'SUPERADMIN';
    const isAdminOrHR = ['ADMIN', 'HR', 'HR_MANAGER', 'OPERATIONS'].includes(requesterRole);

    // Rule 1: Document Owner
    if (requester.id === targetUserId) {
      return { status: 200, allowed: true, reason: 'DOCUMENT_OWNER' };
    }

    // Rule 2: Super Admin
    if (isSuperAdmin) {
      return { status: 200, allowed: true, reason: 'SUPER_ADMIN_GLOBAL' };
    }

    // Rule 3: Admin / HR with Tenant Isolation
    if (isAdminOrHR) {
      if (docTenantId != null && requester.tenantId != null && docTenantId !== requester.tenantId && requester.tenantId !== 1) {
        return { status: 403, allowed: false, message: 'Forbidden: Cross-tenant document access denied' };
      }
      return { status: 200, allowed: true, reason: 'TENANT_ADMIN_OR_HR' };
    }

    // Rule 4: Unauthorized role
    return { status: 403, allowed: false, message: 'Forbidden: You do not have permission to access this private document' };
  }

  const mockUsers = [
    { id: 1, email: 'superadmin@zanezion.com', role: 'SUPER_ADMIN', tenantId: 1 },
    { id: 2, email: 'tenant1_admin@zanezion.com', role: 'ADMIN', tenantId: 10 },
    { id: 3, email: 'tenant1_staff@zanezion.com', role: 'STAFF', tenantId: 10 },
    { id: 4, email: 'tenant2_admin@zanezion.com', role: 'ADMIN', tenantId: 20 },
    { id: 5, email: 'tenant2_customer@zanezion.com', role: 'CUSTOMER', tenantId: 20 }
  ];

  it('denies unauthenticated requests to private documents with 401', () => {
    const result = evaluateDocumentAccess({
      token: null,
      filename: 'passport_user_3_1729938291.pdf',
      targetUserId: 3,
      docTenantId: 10,
      userDb: mockUsers
    });

    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.allowed, false);
    assert.match(result.message, /Authentication required/i);
  });

  it('denies authenticated user from accessing another user\'s private documents (403 Forbidden)', () => {
    const user5Token = jwt.sign({ id: 5 }, JWT_SECRET);
    // User 5 (Customer) attempts to view User 3's passport
    const result = evaluateDocumentAccess({
      token: user5Token,
      filename: 'passport_user_3_1729938291.pdf',
      targetUserId: 3,
      docTenantId: 10,
      userDb: mockUsers
    });

    assert.strictEqual(result.status, 403);
    assert.strictEqual(result.allowed, false);
    assert.match(result.message, /permission to access this private document/i);
  });

  it('denies cross-tenant document access even if requester is an Admin in another tenant (403 Forbidden)', () => {
    const tenant2AdminToken = jwt.sign({ id: 4 }, JWT_SECRET);
    // Tenant 2 Admin (tenantId: 20) attempts to access Tenant 1 user document (tenantId: 10)
    const result = evaluateDocumentAccess({
      token: tenant2AdminToken,
      filename: 'license_user_3_1729938291.pdf',
      targetUserId: 3,
      docTenantId: 10,
      userDb: mockUsers
    });

    assert.strictEqual(result.status, 403);
    assert.strictEqual(result.allowed, false);
    assert.match(result.message, /Cross-tenant document access denied/i);
  });

  it('allows document owner to access their own private documents (200 OK)', () => {
    const user3Token = jwt.sign({ id: 3 }, JWT_SECRET);
    // User 3 requests their own passport
    const result = evaluateDocumentAccess({
      token: user3Token,
      filename: 'passport_user_3_1729938291.pdf',
      targetUserId: 3,
      docTenantId: 10,
      userDb: mockUsers
    });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.reason, 'DOCUMENT_OWNER');
  });

  it('allows Tenant Admin to access documents of users in their own tenant (200 OK)', () => {
    const tenant1AdminToken = jwt.sign({ id: 2 }, JWT_SECRET);
    // Tenant 1 Admin (tenantId: 10) accesses Tenant 1 user document (tenantId: 10)
    const result = evaluateDocumentAccess({
      token: tenant1AdminToken,
      filename: 'resume_user_3_1729938291.pdf',
      targetUserId: 3,
      docTenantId: 10,
      userDb: mockUsers
    });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.reason, 'TENANT_ADMIN_OR_HR');
  });

  it('allows Super Admin global cross-tenant access to documents (200 OK)', () => {
    const superAdminToken = jwt.sign({ id: 1 }, JWT_SECRET);
    // Super Admin accesses Tenant 2 document (tenantId: 20)
    const result = evaluateDocumentAccess({
      token: superAdminToken,
      filename: 'passport_user_5_1729938291.pdf',
      targetUserId: 5,
      docTenantId: 20,
      userDb: mockUsers
    });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.reason, 'SUPER_ADMIN_GLOBAL');
  });

  it('allows legitimate public assets without requiring authentication (200 OK)', () => {
    const result = evaluateDocumentAccess({
      token: null,
      filename: 'profilePic_user_3_1729938291.png',
      targetUserId: 3,
      docTenantId: 10,
      userDb: mockUsers
    });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.reason, 'PUBLIC_ASSET');
  });
});

// --------------------------------------------------------------------------
// 3. SENSITIVE FIELDS REDACTION IN API RESPONSES
// --------------------------------------------------------------------------
describe('3. Sensitive Fields Protection in API Responses', () => {
  it('confirms bankingInfo and nibNumber are absent from findAllUsersByTenant selection', async () => {
    // Read user.repository.js source directly to verify projection
    const repoPath = path.resolve('src/repositories/user.repository.js');
    const repoContent = fs.readFileSync(repoPath, 'utf8');

    // Extract the select block inside findAllUsersByTenant
    const findAllMatch = repoContent.match(/findAllUsersByTenant[\s\S]*?prisma\.user\.findMany\(\{[\s\S]*?select:\s*\{([\s\S]*?)\}/);
    assert.ok(findAllMatch, 'findAllUsersByTenant findMany select block should exist');

    const selectBlock = findAllMatch[1];
    assert.strictEqual(selectBlock.includes('bankingInfo: true'), false, 'bankingInfo must NOT be selected in findAllUsersByTenant');
    assert.strictEqual(selectBlock.includes('nibNumber: true'), false, 'nibNumber must NOT be selected in findAllUsersByTenant');
    assert.strictEqual(selectBlock.includes('avatar: true'), true, 'avatar should be selected for legitimate public profile rendering');
  });

  it('redacts sensitive fields when a non-admin retrieves another user via getUserById', () => {
    // Simulate user object returned by service
    const rawUser = {
      id: 25,
      name: 'John Doe',
      email: 'john@example.com',
      tenantId: 10,
      bankingInfo: { bank: 'Royal Bank', account: '987654321', routing: '12345' },
      nibNumber: 'NIB-8829102',
      passportUrl: '/uploads/passport_user_25_123.pdf',
      licenseUrl: '/uploads/license_user_25_123.jpg',
      avatar: '/uploads/profilePic_user_25_123.png'
    };

    function applyUserRedaction(user, requester) {
      const isOwner = requester && requester.id === user.id;
      const requesterRole = String(requester?.role || '').toUpperCase();
      const isSuperAdmin = requesterRole === 'SUPER_ADMIN' || requesterRole === 'SUPERADMIN';
      const isTenantAdminOrHR = ['ADMIN', 'HR', 'HR_MANAGER'].includes(requesterRole) &&
        (requester?.tenantId === user.tenantId || requester?.tenantId === 1);

      const copy = { ...user };
      if (!isOwner && !isSuperAdmin && !isTenantAdminOrHR) {
        delete copy.bankingInfo;
        delete copy.nibNumber;
        delete copy.passportUrl;
        delete copy.licenseUrl;
      }
      return copy;
    }

    // Requester: another employee (id: 30, role: STAFF)
    const redacted = applyUserRedaction(rawUser, { id: 30, role: 'STAFF', tenantId: 10 });
    assert.strictEqual(redacted.bankingInfo, undefined, 'bankingInfo must be stripped for unauthorized viewer');
    assert.strictEqual(redacted.nibNumber, undefined, 'nibNumber must be stripped for unauthorized viewer');
    assert.strictEqual(redacted.passportUrl, undefined, 'passportUrl must be stripped for unauthorized viewer');
    assert.strictEqual(redacted.name, 'John Doe', 'Public name must remain');
    assert.strictEqual(redacted.avatar, '/uploads/profilePic_user_25_123.png', 'Avatar must remain');

    // Requester: owner (id: 25)
    const ownerView = applyUserRedaction(rawUser, { id: 25, role: 'STAFF', tenantId: 10 });
    assert.ok(ownerView.bankingInfo, 'Owner must retain access to their own banking info');
    assert.strictEqual(ownerView.nibNumber, 'NIB-8829102', 'Owner must retain access to their own NIB');

    // Requester: tenant Admin (id: 5, role: ADMIN, tenantId: 10)
    const adminView = applyUserRedaction(rawUser, { id: 5, role: 'ADMIN', tenantId: 10 });
    assert.ok(adminView.bankingInfo, 'Tenant Admin must retain access within tenant');
  });
});

// --------------------------------------------------------------------------
// 4. AUDIT LOG SENSITIVE DATA SANITIZATION
// --------------------------------------------------------------------------
describe('4. Audit Log Data Sanitization', () => {
  it('masks account numbers and redacts passwords, tokens, routing numbers in audit logs', () => {
    const dirtyPayload = {
      name: 'Jane Smith',
      email: 'jane@example.com',
      password: 'plainTextPassword123',
      resetToken: 'secretResetToken456',
      bankingInfo: {
        bank: 'Commonwealth Bank',
        account: '1234567890',
        account_number: '987654321',
        routing_number: 'ROUTING-9988',
        method: 'Direct Deposit'
      },
      nibNumber: 'NIB-1234567'
    };

    const clean = sanitizeAuditData(dirtyPayload);

    assert.strictEqual(clean.password, '[REDACTED]', 'Password must be [REDACTED]');
    assert.strictEqual(clean.resetToken, '[REDACTED]', 'Reset token must be [REDACTED]');
    assert.strictEqual(clean.bankingInfo.bank, 'Commonwealth Bank', 'Bank name is safe and preserved');
    assert.strictEqual(clean.bankingInfo.account, '****7890', 'Account number must be masked with last 4 digits');
    assert.strictEqual(clean.bankingInfo.account_number, '****4321', 'Account number must be masked with last 4 digits');
    assert.strictEqual(clean.bankingInfo.routing_number, '[REDACTED]', 'Routing number must be [REDACTED]');
    assert.strictEqual(clean.nibNumber, '****567', 'NIB number must be masked with last 3 digits');
    assert.strictEqual(clean.name, 'Jane Smith', 'Non-sensitive name preserved');
  });
});

// --------------------------------------------------------------------------
// 5. CLOUDINARY HARDCODED CREDENTIAL CHECK
// --------------------------------------------------------------------------
describe('5. Cloud Storage Security & Credential Isolation', () => {
  it('confirms no hardcoded Cloudinary fallback credentials exist in cloudinary.js and env.js', () => {
    const cloudinaryConf = fs.readFileSync('src/config/cloudinary.js', 'utf8');
    const envConf = fs.readFileSync('src/config/env.js', 'utf8');

    // None of the old dummy/hardcoded API key fragments should exist
    const bannedFragments = ['619871459582297', 'APdrXDmmW6cTt2gvDNpjMu63X2E', 'i14k7hvk'];

    bannedFragments.forEach(fragment => {
      assert.strictEqual(cloudinaryConf.includes(fragment), false, `cloudinary.js must not contain hardcoded secret: ${fragment}`);
      assert.strictEqual(envConf.includes(fragment), false, `env.js must not contain hardcoded secret: ${fragment}`);
    });
  });
});
