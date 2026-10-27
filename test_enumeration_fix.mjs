import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import app from './src/app.js';
import prisma from './src/config/db.js';
import { config } from './src/config/env.js';

const JWT_SECRET = config.jwtSecret || 'zanezion_super_secret_key_2026';

describe('File Existence Enumeration Fix Verification Suite', () => {
  let server;
  let baseUrl;
  const uploadsDir = path.join(process.cwd(), 'uploads');
  const existingProtectedFile = 'passport_user_10_existing.pdf';
  const nonexistentProtectedFile = 'passport_user_10_nonexistent.pdf';
  const existingPublicFile = 'profilePic_user_10_existing.png';
  const nonexistentPublicFile = 'profilePic_user_10_nonexistent.png';

  const existingProtectedPath = path.join(uploadsDir, existingProtectedFile);
  const existingPublicPath = path.join(uploadsDir, existingPublicFile);

  // Mock Users
  const mockUsers = [
    { id: 1, email: 'superadmin@zanezion.com', role: { name: 'SUPER_ADMIN' }, tenantId: 1 },
    { id: 10, email: 'owner@tenant1.com', role: { name: 'STAFF' }, tenantId: 10 },
    { id: 20, email: 'admin@tenant1.com', role: { name: 'ADMIN' }, tenantId: 10 },
    { id: 30, email: 'staff@tenant1.com', role: { name: 'STAFF' }, tenantId: 10 },
    { id: 40, email: 'admin@tenant2.com', role: { name: 'ADMIN' }, tenantId: 20 },
  ];

  // Helper tokens
  const ownerToken = jwt.sign({ id: 10 }, JWT_SECRET);
  const sameTenantAdminToken = jwt.sign({ id: 20 }, JWT_SECRET);
  const unauthorizedStaffToken = jwt.sign({ id: 30 }, JWT_SECRET);
  const crossTenantAdminToken = jwt.sign({ id: 40 }, JWT_SECRET);
  const invalidToken = 'invalid.jwt.signature-here';

  before(async () => {
    // Ensure directory exists
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Create existing files on disk
    fs.writeFileSync(existingProtectedPath, 'CONFIDENTIAL_PASSPORT_STREAM_DATA');
    fs.writeFileSync(existingPublicPath, 'PUBLIC_AVATAR_STREAM_DATA');

    // Ensure nonexistent files are not on disk
    const nonexistentProtectedPath = path.join(uploadsDir, nonexistentProtectedFile);
    if (fs.existsSync(nonexistentProtectedPath)) fs.unlinkSync(nonexistentProtectedPath);
    const nonexistentPublicPath = path.join(uploadsDir, nonexistentPublicFile);
    if (fs.existsSync(nonexistentPublicPath)) fs.unlinkSync(nonexistentPublicPath);

    // Mock prisma queries for test execution
    prisma.user.findFirst = async ({ where }) => {
      const u = mockUsers.find(user => user.id === where?.id);
      return u || null;
    };
    prisma.user.findUnique = async ({ where }) => {
      const u = mockUsers.find(user => user.id === where?.id);
      return u ? { id: u.id, tenantId: u.tenantId } : null;
    };
    prisma.employeeDocument.findFirst = async () => null;
    prisma.client.findFirst = async () => null;

    // Start server on ephemeral port
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    try {
      if (fs.existsSync(existingProtectedPath)) fs.unlinkSync(existingProtectedPath);
      if (fs.existsSync(existingPublicPath)) fs.unlinkSync(existingPublicPath);
    } catch (_) {}
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  // ------------------------------------------------------------------------
  // 1. Existing protected file, no token
  // ------------------------------------------------------------------------
  it('1. Existing protected file without token returns 401 Unauthorized', async () => {
    const res = await fetch(`${baseUrl}/uploads/${existingProtectedFile}`);
    const body = await res.json();

    assert.strictEqual(res.status, 401, 'Status must be 401 Unauthorized');
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.message, 'Authentication required: Access to private personal documents is restricted');
  });

  // ------------------------------------------------------------------------
  // 2. Nonexistent protected file, no token
  // ------------------------------------------------------------------------
  it('2. Nonexistent protected file without token returns identical 401 Unauthorized', async () => {
    const res = await fetch(`${baseUrl}/uploads/${nonexistentProtectedFile}`);
    const body = await res.json();

    assert.strictEqual(res.status, 401, 'Status must be 401 Unauthorized (not 404)');
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.message, 'Authentication required: Access to private personal documents is restricted');
  });

  // ------------------------------------------------------------------------
  // 3. Invalid token (both existing and nonexistent)
  // ------------------------------------------------------------------------
  it('3. Invalid token returns identical 401 on both existing and nonexistent protected files', async () => {
    const resExisting = await fetch(`${baseUrl}/uploads/${existingProtectedFile}`, {
      headers: { Authorization: `Bearer ${invalidToken}` }
    });
    const bodyExisting = await resExisting.json();

    const resNonexistent = await fetch(`${baseUrl}/uploads/${nonexistentProtectedFile}`, {
      headers: { Authorization: `Bearer ${invalidToken}` }
    });
    const bodyNonexistent = await resNonexistent.json();

    assert.strictEqual(resExisting.status, 401, 'Existing file with invalid token must return 401');
    assert.strictEqual(resNonexistent.status, 401, 'Nonexistent file with invalid token must return 401 (not 404)');
    assert.strictEqual(bodyExisting.message, 'Invalid or expired authentication token');
    assert.strictEqual(bodyNonexistent.message, 'Invalid or expired authentication token');
  });

  // ------------------------------------------------------------------------
  // 4 & 5. File belonging to another user (unauthorized requester)
  // ------------------------------------------------------------------------
  it('4. Existing file belonging to another user returns 403 Forbidden to unauthorized user', async () => {
    const res = await fetch(`${baseUrl}/uploads/${existingProtectedFile}`, {
      headers: { Authorization: `Bearer ${unauthorizedStaffToken}` }
    });
    const body = await res.json();

    assert.strictEqual(res.status, 403, 'Must return 403 Forbidden');
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.message, 'Forbidden: You do not have permission to access this private document');
  });

  it('5. Nonexistent file belonging to another user returns identical 403 Forbidden to unauthorized user', async () => {
    const res = await fetch(`${baseUrl}/uploads/${nonexistentProtectedFile}`, {
      headers: { Authorization: `Bearer ${unauthorizedStaffToken}` }
    });
    const body = await res.json();

    assert.strictEqual(res.status, 403, 'Must return 403 Forbidden (not 404)');
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.message, 'Forbidden: You do not have permission to access this private document');
  });

  // ------------------------------------------------------------------------
  // 6. Cross-tenant Admin attempting access
  // ------------------------------------------------------------------------
  it('6. Cross-tenant Admin receives identical 403 Forbidden on both existing and nonexistent files', async () => {
    const resExisting = await fetch(`${baseUrl}/uploads/${existingProtectedFile}`, {
      headers: { Authorization: `Bearer ${crossTenantAdminToken}` }
    });
    const bodyExisting = await resExisting.json();

    const resNonexistent = await fetch(`${baseUrl}/uploads/${nonexistentProtectedFile}`, {
      headers: { Authorization: `Bearer ${crossTenantAdminToken}` }
    });
    const bodyNonexistent = await resNonexistent.json();

    assert.strictEqual(resExisting.status, 403, 'Existing file cross-tenant must return 403');
    assert.strictEqual(resNonexistent.status, 403, 'Nonexistent file cross-tenant must return 403 (not 404)');
    assert.strictEqual(bodyExisting.message, 'Forbidden: Cross-tenant document access denied');
    assert.strictEqual(bodyNonexistent.message, 'Forbidden: Cross-tenant document access denied');
  });

  // ------------------------------------------------------------------------
  // 7. Authorized owner
  // ------------------------------------------------------------------------
  it('7. Authorized owner accesses existing file (200 OK) and nonexistent file (404 Not Found)', async () => {
    const resExisting = await fetch(`${baseUrl}/uploads/${existingProtectedFile}`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const textExisting = await resExisting.text();

    const resNonexistent = await fetch(`${baseUrl}/uploads/${nonexistentProtectedFile}`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const bodyNonexistent = await resNonexistent.json();

    assert.strictEqual(resExisting.status, 200, 'Owner accessing existing file must receive 200 OK');
    assert.strictEqual(textExisting, 'CONFIDENTIAL_PASSPORT_STREAM_DATA');

    assert.strictEqual(resNonexistent.status, 404, 'Owner accessing nonexistent file receives 404 Not Found');
    assert.strictEqual(bodyNonexistent.success, false);
    assert.strictEqual(bodyNonexistent.message, 'File not found');
  });

  // ------------------------------------------------------------------------
  // 8. Authorized tenant Admin
  // ------------------------------------------------------------------------
  it('8. Authorized tenant Admin accesses existing file (200 OK) and nonexistent file (404 Not Found)', async () => {
    const resExisting = await fetch(`${baseUrl}/uploads/${existingProtectedFile}`, {
      headers: { Authorization: `Bearer ${sameTenantAdminToken}` }
    });
    const textExisting = await resExisting.text();

    const resNonexistent = await fetch(`${baseUrl}/uploads/${nonexistentProtectedFile}`, {
      headers: { Authorization: `Bearer ${sameTenantAdminToken}` }
    });
    const bodyNonexistent = await resNonexistent.json();

    assert.strictEqual(resExisting.status, 200, 'Tenant Admin accessing existing file must receive 200 OK');
    assert.strictEqual(textExisting, 'CONFIDENTIAL_PASSPORT_STREAM_DATA');

    assert.strictEqual(resNonexistent.status, 404, 'Tenant Admin accessing nonexistent file receives 404 Not Found');
    assert.strictEqual(bodyNonexistent.success, false);
    assert.strictEqual(bodyNonexistent.message, 'File not found');
  });

  // ------------------------------------------------------------------------
  // 9. Existing and nonexistent public asset paths
  // ------------------------------------------------------------------------
  it('9. Public asset path returns 200 OK when existing and 404 Not Found when nonexistent (no auth needed)', async () => {
    const resExisting = await fetch(`${baseUrl}/uploads/${existingPublicFile}`);
    const textExisting = await resExisting.text();

    const resNonexistent = await fetch(`${baseUrl}/uploads/${nonexistentPublicFile}`);
    const bodyNonexistent = await resNonexistent.json();

    assert.strictEqual(resExisting.status, 200, 'Existing public asset must be served with 200 OK without token');
    assert.strictEqual(textExisting, 'PUBLIC_AVATAR_STREAM_DATA');

    assert.strictEqual(resNonexistent.status, 404, 'Nonexistent public asset must return 404 Not Found without token');
    assert.strictEqual(bodyNonexistent.success, false);
    assert.strictEqual(bodyNonexistent.message, 'File not found');
  });

  // ------------------------------------------------------------------------
  // 10. Path traversal attempts
  // ------------------------------------------------------------------------
  it('10. Path traversal attempts are rejected with 400 Bad Request or 403 Forbidden', async () => {
    const resDots = await fetch(`${baseUrl}/uploads/..%2fpackage.json`);
    assert.ok(
      resDots.status === 400 || resDots.status === 403 || resDots.status === 404,
      `Traversal with .. must be blocked, got ${resDots.status}`
    );

    const resEncoded = await fetch(`${baseUrl}/uploads/%2e%2e%2f%2e%2e%2fpackage.json`);
    assert.ok(
      resEncoded.status === 400 || resEncoded.status === 403 || resEncoded.status === 404,
      `Encoded traversal must be blocked, got ${resEncoded.status}`
    );
  });
});
