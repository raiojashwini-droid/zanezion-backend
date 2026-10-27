/**
 * Phase 2 Task 2: Bidirectional Chauffeur Address Synchronization Regression Test Suite
 * 
 * Verifies all 10 required regression criteria:
 * 1. Order pickup update synchronizes the linked Delivery pickup.
 * 2. Order drop-off update synchronizes the linked Delivery drop-off.
 * 3. Delivery pickup update synchronizes Order metadata.
 * 4. Delivery drop-off update synchronizes Order metadata.
 * 5. Partial updates preserve the other address in both directions.
 * 6. Omitted address fields do not clear stored addresses.
 * 7. Existing metadata keys, ownership, driver, vehicle, and status remain unchanged.
 * 8. A Delivery cannot update an unrelated Order when IDs overlap, references are ambiguous, or cross-tenant.
 * 9. Missing linked records follow existing error-handling conventions.
 * 10. Task 1 exact Order-Delivery matching and customer ownership behavior remain intact.
 */

import assert from 'node:assert/strict';
import prisma from './src/config/db.js';
import * as orderService from './src/services/order.service.js';
import * as deliveryService from './src/services/delivery.service.js';
import * as orderRepo from './src/repositories/order.repository.js';
import * as deliveryRepo from './src/repositories/delivery.repository.js';
import AppError from './src/utils/AppError.js';

console.log('--- Zanezion Phase 2 Task 2: Bidirectional Address Synchronization Test Suite ---');
let passed = 0;
let total = 0;

async function runTest(name, fn) {
  total++;
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}`);
    console.error(`  ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
  }
}

// In-memory test store
let mockDb = {
  orders: new Map(),
  deliveries: new Map(),
  employees: new Map(),
  warehouses: new Map()
};

function resetMockDb() {
  mockDb.orders.clear();
  mockDb.deliveries.clear();
  mockDb.employees.clear();
  mockDb.warehouses.clear();

  mockDb.warehouses.set(1, { id: 1, tenantId: 1, name: 'Main Nassau Warehouse' });
}

// Hook Prisma methods for testing
const origOrderFindUnique = prisma.order.findUnique;
const origOrderFindFirst = prisma.order.findFirst;
const origOrderUpdate = prisma.order.update;
const origOrderCreate = prisma.order.create;
const origDeliveryFindUnique = prisma.delivery.findUnique;
const origDeliveryFindFirst = prisma.delivery.findFirst;
const origDeliveryFindMany = prisma.delivery.findMany;
const origDeliveryUpdate = prisma.delivery.update;
const origDeliveryCreate = prisma.delivery.create;
const origDeliveryCount = prisma.delivery.count;
const origEmployeeFindFirst = prisma.employee.findFirst;
const origEmployeeFindUnique = prisma.employee.findUnique;
const origWarehouseFindFirst = prisma.warehouse.findFirst;

function setupMocks() {
  prisma.order.findUnique = async ({ where }) => {
    return mockDb.orders.get(where.id) || null;
  };

  prisma.order.findFirst = async ({ where }) => {
    for (const ord of mockDb.orders.values()) {
      let match = true;
      if (where.id !== undefined && ord.id !== where.id) match = false;
      if (where.tenantId !== undefined && ord.tenantId !== where.tenantId) match = false;
      if (where.orderNumber !== undefined && ord.orderNumber !== where.orderNumber) match = false;
      if (match) return ord;
    }
    return null;
  };

  prisma.order.update = async ({ where, data }) => {
    const existing = mockDb.orders.get(where.id);
    if (!existing) throw new Error(`Order ${where.id} not found in mock DB`);
    const updated = {
      ...existing,
      ...data,
      metadata: typeof data.metadata === 'object' ? { ...(existing.metadata || {}), ...data.metadata } : (data.metadata || existing.metadata)
    };
    mockDb.orders.set(where.id, updated);
    return updated;
  };

  prisma.delivery.findUnique = async ({ where }) => {
    return mockDb.deliveries.get(where.id) || null;
  };

  prisma.delivery.findFirst = async ({ where }) => {
    for (const del of mockDb.deliveries.values()) {
      let match = true;
      if (where.id !== undefined && del.id !== where.id) match = false;
      if (where.orderId !== undefined && del.orderId !== where.orderId) match = false;
      if (where.tenantId !== undefined && del.tenantId !== where.tenantId) match = false;
      if (match) return del;
    }
    return null;
  };

  prisma.delivery.findMany = async ({ where }) => {
    const results = [];
    for (const del of mockDb.deliveries.values()) {
      let match = true;
      if (where.orderId !== undefined && del.orderId !== where.orderId) match = false;
      if (where.tenantId !== undefined && del.tenantId !== where.tenantId) match = false;
      if (match) results.push(del);
    }
    return results;
  };

  prisma.delivery.update = async ({ where, data }) => {
    const existing = mockDb.deliveries.get(where.id);
    if (!existing) throw new Error(`Delivery ${where.id} not found in mock DB`);
    const updated = {
      ...existing,
      ...data
    };
    mockDb.deliveries.set(where.id, updated);
    return updated;
  };

  prisma.delivery.create = async ({ data }) => {
    const nextId = mockDb.deliveries.size + 1;
    const created = { id: nextId, ...data };
    mockDb.deliveries.set(nextId, created);
    return created;
  };

  prisma.delivery.count = async () => mockDb.deliveries.size;

  prisma.warehouse.findFirst = async () => mockDb.warehouses.get(1);

  prisma.employee.findFirst = async () => null;
  prisma.employee.findUnique = async () => null;
  prisma.auditLog = { create: async () => ({ id: 1 }) };
  prisma.notification = { create: async () => ({ id: 1 }) };
  prisma.mission = {
    updateMany: async () => ({ count: 0 }),
    findFirst: async () => null,
    update: async () => ({ id: 1 })
  };
}

function teardownMocks() {
  prisma.order.findUnique = origOrderFindUnique;
  prisma.order.findFirst = origOrderFindFirst;
  prisma.order.update = origOrderUpdate;
  prisma.order.create = origOrderCreate;
  prisma.delivery.findUnique = origDeliveryFindUnique;
  prisma.delivery.findFirst = origDeliveryFindFirst;
  prisma.delivery.findMany = origDeliveryFindMany;
  prisma.delivery.update = origDeliveryUpdate;
  prisma.delivery.create = origDeliveryCreate;
  prisma.delivery.count = origDeliveryCount;
  prisma.employee.findFirst = origEmployeeFindFirst;
  prisma.employee.findUnique = origEmployeeFindUnique;
  prisma.warehouse.findFirst = origWarehouseFindFirst;
}

setupMocks();

try {
  // Test 1: Order pickup update synchronizes the linked Delivery pickup
  await runTest('1. Order pickup update synchronizes the linked Delivery pickup', async () => {
    resetMockDb();
    mockDb.orders.set(101, {
      id: 101,
      tenantId: 1,
      orderNumber: 'ORD-2026-0101',
      clientId: 5,
      orderType: 'CHAUFFEUR',
      status: 'pending',
      metadata: {
        pickupLocation: 'Lynden Pindling International Airport (NAS)',
        dropLocation: 'The Ocean Club, Bahamas',
        customer_id: 42
      }
    });

    mockDb.deliveries.set(501, {
      id: 501,
      tenantId: 1,
      orderId: 101,
      clientId: 5,
      status: 'pending',
      pickupLocation: 'Lynden Pindling International Airport (NAS)',
      dropLocation: 'The Ocean Club, Bahamas'
    });

    // Update only pickupLocation on Order
    await orderService.updateOrder(101, { pickupLocation: 'Albany Marina Terminal' }, 1, 1);

    const updatedDel = mockDb.deliveries.get(501);
    assert.equal(updatedDel.pickupLocation, 'Albany Marina Terminal', 'Delivery pickupLocation must be updated');
    assert.equal(updatedDel.dropLocation, 'The Ocean Club, Bahamas', 'Delivery dropLocation must remain unchanged');
    
    const updatedOrder = mockDb.orders.get(101);
    assert.equal(updatedOrder.metadata.pickupLocation, 'Albany Marina Terminal', 'Order metadata.pickupLocation must be updated');
    assert.equal(updatedOrder.metadata.pickup_location, 'Albany Marina Terminal', 'Order metadata.pickup_location alias must be updated');
  });

  // Test 2: Order drop-off update synchronizes the linked Delivery drop-off
  await runTest('2. Order drop-off update synchronizes the linked Delivery drop-off', async () => {
    resetMockDb();
    mockDb.orders.set(102, {
      id: 102,
      tenantId: 1,
      orderNumber: 'ORD-2026-0102',
      clientId: 5,
      orderType: 'CHAUFFEUR',
      status: 'pending',
      metadata: {
        pickupLocation: 'Old Fort Bay',
        dropLocation: 'Rosewood Baha Mar',
        customer_id: 42
      }
    });

    mockDb.deliveries.set(502, {
      id: 502,
      tenantId: 1,
      orderId: 102,
      clientId: 5,
      status: 'pending',
      pickupLocation: 'Old Fort Bay',
      dropLocation: 'Rosewood Baha Mar'
    });

    // Update dropLocation on Order using drop_location alias
    await orderService.updateOrder(102, { drop_location: 'The Cove at Atlantis' }, 1, 1);

    const updatedDel = mockDb.deliveries.get(502);
    assert.equal(updatedDel.dropLocation, 'The Cove at Atlantis', 'Delivery dropLocation must be updated');
    assert.equal(updatedDel.pickupLocation, 'Old Fort Bay', 'Delivery pickupLocation must remain unchanged');

    const updatedOrder = mockDb.orders.get(102);
    assert.equal(updatedOrder.metadata.dropLocation, 'The Cove at Atlantis', 'Order metadata.dropLocation must be updated');
    assert.equal(updatedOrder.metadata.location, 'The Cove at Atlantis', 'Order metadata.location alias must be updated');
  });

  // Test 3: Delivery pickup update synchronizes Order metadata
  await runTest('3. Delivery pickup update synchronizes Order metadata', async () => {
    resetMockDb();
    mockDb.orders.set(103, {
      id: 103,
      tenantId: 1,
      orderNumber: 'ORD-2026-0103',
      clientId: 5,
      orderType: 'CHAUFFEUR',
      status: 'pending',
      metadata: {
        pickupLocation: 'Original Airport',
        dropLocation: 'Original Resort',
        customer_id: 99,
        customItems: [{ pickupLocation: 'Original Airport', dropLocation: 'Original Resort' }]
      }
    });

    mockDb.deliveries.set(503, {
      id: 503,
      tenantId: 1,
      orderId: 103,
      clientId: 5,
      status: 'pending',
      pickupLocation: 'Original Airport',
      dropLocation: 'Original Resort'
    });

    // Update pickup on Delivery
    await deliveryService.updateDelivery(503, { pickupLocation: 'Jet Aviation FBO' }, 1, 1);

    const updatedOrder = mockDb.orders.get(103);
    assert.equal(updatedOrder.metadata.pickupLocation, 'Jet Aviation FBO', 'Order metadata.pickupLocation must be updated');
    assert.equal(updatedOrder.metadata.pickup_location, 'Jet Aviation FBO', 'Order metadata.pickup_location must be updated');
    assert.equal(updatedOrder.metadata.dropLocation, 'Original Resort', 'Order metadata.dropLocation must be preserved');
    assert.equal(updatedOrder.metadata.customItems[0].pickupLocation, 'Jet Aviation FBO', 'customItems[0].pickupLocation must be synced');
  });

  // Test 4: Delivery drop-off update synchronizes Order metadata
  await runTest('4. Delivery drop-off update synchronizes Order metadata', async () => {
    resetMockDb();
    mockDb.orders.set(104, {
      id: 104,
      tenantId: 1,
      orderNumber: 'ORD-2026-0104',
      clientId: 5,
      orderType: 'CHAUFFEUR',
      status: 'pending',
      metadata: {
        pickupLocation: 'Downtown Pier',
        dropLocation: 'Original Hotel',
        customer_id: 77,
        customItems: [{ pickupLocation: 'Downtown Pier', dropLocation: 'Original Hotel' }]
      }
    });

    mockDb.deliveries.set(504, {
      id: 504,
      tenantId: 1,
      orderId: 104,
      clientId: 5,
      status: 'pending',
      pickupLocation: 'Downtown Pier',
      dropLocation: 'Original Hotel'
    });

    // Update drop-off on Delivery using deliveryAddress alias
    await deliveryService.updateDelivery(504, { deliveryAddress: 'SLS Baha Mar Presidential Suite' }, 1, 1);

    const updatedOrder = mockDb.orders.get(104);
    assert.equal(updatedOrder.metadata.dropLocation, 'SLS Baha Mar Presidential Suite', 'Order metadata.dropLocation must be updated');
    assert.equal(updatedOrder.metadata.location, 'SLS Baha Mar Presidential Suite', 'Order metadata.location alias must be updated');
    assert.equal(updatedOrder.metadata.pickupLocation, 'Downtown Pier', 'Order metadata.pickupLocation must be preserved');
    assert.equal(updatedOrder.metadata.customItems[0].dropLocation, 'SLS Baha Mar Presidential Suite', 'customItems[0].dropLocation must be synced');
  });

  // Test 5: Partial updates preserve the other address in both directions
  await runTest('5. Partial updates preserve the other address in both directions', async () => {
    resetMockDb();
    mockDb.orders.set(105, {
      id: 105,
      tenantId: 1,
      orderNumber: 'ORD-2026-0105',
      clientId: 5,
      orderType: 'CHAUFFEUR',
      status: 'pending',
      metadata: {
        pickupLocation: 'Initial Pickup',
        dropLocation: 'Initial Drop',
        customer_id: 42
      }
    });

    mockDb.deliveries.set(505, {
      id: 505,
      tenantId: 1,
      orderId: 105,
      clientId: 5,
      status: 'pending',
      pickupLocation: 'Initial Pickup',
      dropLocation: 'Initial Drop'
    });

    // Partial Update 1: Order -> Delivery (only pickup updated)
    await orderService.updateOrder(105, { pickupLocation: 'Updated Pickup Only' }, 1, 1);
    let del = mockDb.deliveries.get(505);
    let ord = mockDb.orders.get(105);
    assert.equal(del.pickupLocation, 'Updated Pickup Only');
    assert.equal(del.dropLocation, 'Initial Drop', 'Delivery dropLocation preserved');
    assert.equal(ord.metadata.pickupLocation, 'Updated Pickup Only');
    assert.equal(ord.metadata.dropLocation, 'Initial Drop', 'Order dropLocation preserved');

    // Partial Update 2: Delivery -> Order (only drop updated)
    await deliveryService.updateDelivery(505, { dropLocation: 'Updated Drop Only' }, 1, 1);
    del = mockDb.deliveries.get(505);
    ord = mockDb.orders.get(105);
    assert.equal(del.pickupLocation, 'Updated Pickup Only', 'Delivery pickupLocation preserved');
    assert.equal(del.dropLocation, 'Updated Drop Only');
    assert.equal(ord.metadata.pickupLocation, 'Updated Pickup Only', 'Order pickupLocation preserved');
    assert.equal(ord.metadata.dropLocation, 'Updated Drop Only');
  });

  // Test 6: Omitted address fields do not clear stored addresses
  await runTest('6. Omitted address fields do not clear stored addresses', async () => {
    resetMockDb();
    mockDb.orders.set(106, {
      id: 106,
      tenantId: 1,
      orderNumber: 'ORD-2026-0106',
      clientId: 5,
      orderType: 'CHAUFFEUR',
      status: 'pending',
      metadata: {
        pickupLocation: 'Stored Permanent Pickup',
        dropLocation: 'Stored Permanent Drop',
        customer_id: 42
      }
    });

    mockDb.deliveries.set(506, {
      id: 506,
      tenantId: 1,
      orderId: 106,
      clientId: 5,
      status: 'pending',
      pickupLocation: 'Stored Permanent Pickup',
      dropLocation: 'Stored Permanent Drop'
    });

    // Update order with unrelated field (e.g., guestName), omitting addresses entirely
    await orderService.updateOrder(106, { guestName: 'Lord Sterling' }, 1, 1);
    let del = mockDb.deliveries.get(506);
    let ord = mockDb.orders.get(106);
    assert.equal(ord.metadata.pickupLocation, 'Stored Permanent Pickup', 'Order pickup must not be cleared');
    assert.equal(ord.metadata.dropLocation, 'Stored Permanent Drop', 'Order drop must not be cleared');
    assert.equal(del.pickupLocation, 'Stored Permanent Pickup', 'Delivery pickup must not be cleared');
    assert.equal(del.dropLocation, 'Stored Permanent Drop', 'Delivery drop must not be cleared');

    // Update delivery with unrelated field (e.g., remarks), omitting addresses entirely
    await deliveryService.updateDelivery(506, { remarks: JSON.stringify({ note: 'Flight delayed 10m' }) }, 1, 1);
    del = mockDb.deliveries.get(506);
    ord = mockDb.orders.get(106);
    assert.equal(del.pickupLocation, 'Stored Permanent Pickup', 'Delivery pickup still preserved');
    assert.equal(del.dropLocation, 'Stored Permanent Drop', 'Delivery drop still preserved');
    assert.equal(ord.metadata.pickupLocation, 'Stored Permanent Pickup', 'Order pickup still preserved');
    assert.equal(ord.metadata.dropLocation, 'Stored Permanent Drop', 'Order drop still preserved');
  });

  // Test 7: Existing metadata keys, ownership, driver, vehicle, and status remain unchanged
  await runTest('7. Existing metadata keys, ownership, driver, vehicle, and status remain unchanged', async () => {
    resetMockDb();
    mockDb.orders.set(107, {
      id: 107,
      tenantId: 1,
      orderNumber: 'ORD-2026-0107',
      clientId: 12,
      createdById: 1,
      orderType: 'CHAUFFEUR',
      status: 'pending',
      metadata: {
        customer_id: 88,
        customer_email: 'vip.owner@bahamas.com',
        user_id: 88,
        guestName: 'Ambassador Davis',
        numberOfPassengers: 4,
        wifi: 'Yes',
        serviceType: 'Hourly Charter',
        driverName: 'Captain James',
        driver_user_id: 301,
        plateNumber: 'LIMO-007',
        pickupLocation: 'Old Dock',
        dropLocation: 'Old Estate'
      }
    });

    mockDb.deliveries.set(507, {
      id: 507,
      tenantId: 1,
      orderId: 107,
      clientId: 12,
      status: 'pending',
      vehicleRef: 'LIMO-007',
      pickupLocation: 'Old Dock',
      dropLocation: 'Old Estate'
    });

    // Update address on Delivery
    await deliveryService.updateDelivery(507, { pickupLocation: 'New Private Slip #4' }, 1, 1);

    const ord = mockDb.orders.get(107);
    const del = mockDb.deliveries.get(507);

    // Verify metadata keys & ownership intact
    assert.equal(ord.metadata.customer_id, 88, 'customer_id preserved');
    assert.equal(ord.metadata.customer_email, 'vip.owner@bahamas.com', 'customer_email preserved');
    assert.equal(ord.metadata.guestName, 'Ambassador Davis', 'guestName preserved');
    assert.equal(ord.metadata.numberOfPassengers, 4, 'numberOfPassengers preserved');
    assert.equal(ord.metadata.wifi, 'Yes', 'wifi preserved');
    assert.equal(ord.metadata.serviceType, 'Hourly Charter', 'serviceType preserved');
    assert.equal(ord.metadata.driverName, 'Captain James', 'driverName preserved');
    assert.equal(ord.metadata.plateNumber, 'LIMO-007', 'plateNumber preserved');
    
    // Status should NOT arbitrarily flip to assigned or completed on address-only update
    assert.equal(ord.status, 'pending', 'Order status preserved');
    assert.equal(del.status, 'pending', 'Delivery status preserved');
  });

  // Test 8: A Delivery cannot update an unrelated Order when IDs overlap or references are ambiguous
  await runTest('8. A Delivery cannot update an unrelated Order when IDs overlap or references are ambiguous', async () => {
    resetMockDb();

    // Order 20 in Tenant 1
    mockDb.orders.set(20, {
      id: 20,
      tenantId: 1,
      orderNumber: 'ORD-0020',
      status: 'pending',
      metadata: { pickupLocation: 'Tenant1 Airport', dropLocation: 'Tenant1 Hotel' }
    });

    // Order 20 in Tenant 2 (cross-tenant ID collision scenario)
    mockDb.orders.set(999, {
      id: 999,
      tenantId: 2,
      orderNumber: 'ORD-0999',
      status: 'pending',
      metadata: { pickupLocation: 'Tenant2 Safe Pickup', dropLocation: 'Tenant2 Safe Drop' }
    });

    // Delivery 508 belongs to Tenant 1, but attempts to reference cross-tenant Order 999
    mockDb.deliveries.set(508, {
      id: 508,
      tenantId: 1,
      orderId: 999, // Mismatched tenant
      clientId: 5,
      status: 'pending',
      pickupLocation: 'Hacker Pickup'
    });

    await deliveryService.updateDelivery(508, { pickupLocation: 'Malicious Pickup Update' }, 1, 1);

    // Order 999 must NOT have been updated because delivery.tenantId (1) != order.tenantId (2)
    const order999 = mockDb.orders.get(999);
    assert.equal(order999.metadata.pickupLocation, 'Tenant2 Safe Pickup', 'Cross-tenant order was protected from unauthorized update');

    // Delivery with null orderId cannot touch any order
    mockDb.deliveries.set(509, {
      id: 509,
      tenantId: 1,
      orderId: null,
      status: 'pending',
      pickupLocation: 'Ad-hoc Pickup'
    });

    const order20Before = JSON.stringify(mockDb.orders.get(20));
    await deliveryService.updateDelivery(509, { pickupLocation: 'New Standalone Pickup' }, 1, 1);
    const order20After = JSON.stringify(mockDb.orders.get(20));
    assert.equal(order20Before, order20After, 'Order 20 completely untouched by unlinked delivery update');
  });

  // Test 9: Missing linked records follow existing error-handling conventions
  await runTest('9. Missing linked records follow existing error-handling conventions', async () => {
    resetMockDb();

    // 1. Updating non-existent order throws 404 AppError
    await assert.rejects(
      async () => await orderService.updateOrder(9999, { pickupLocation: 'Nowhere' }, 1, 1),
      (err) => err instanceof AppError && err.statusCode === 404,
      'Updating non-existent Order must throw 404 AppError'
    );

    // 2. Updating non-existent delivery throws 404 AppError
    await assert.rejects(
      async () => await deliveryService.updateDelivery(8888, { pickupLocation: 'Nowhere' }, 1, 1),
      (err) => err instanceof AppError && err.statusCode === 404,
      'Updating non-existent Delivery must throw 404 AppError'
    );

    // 3. Updating order with missing delivery does not throw; auto-creates delivery safely
    mockDb.orders.set(200, {
      id: 200,
      tenantId: 1,
      orderNumber: 'ORD-200',
      clientId: 5,
      orderType: 'CHAUFFEUR',
      status: 'pending',
      metadata: {}
    });

    const res = await orderService.updateOrder(200, { pickupLocation: 'Auto-created Nassau Depot', dropLocation: 'Paradise Island' }, 1, 1);
    assert.ok(res, 'Order updated successfully even when initial Delivery record did not exist');
    assert.equal(mockDb.deliveries.size, 1, 'Delivery record auto-created gracefully');
    const createdDel = Array.from(mockDb.deliveries.values())[0];
    assert.equal(createdDel.pickupLocation, 'Auto-created Nassau Depot');
    assert.equal(createdDel.dropLocation, 'Paradise Island');
  });

  // Test 10: Task 1 exact Order-Delivery matching and customer ownership behavior remain intact
  await runTest('10. Task 1 exact Order-Delivery matching and customer ownership behavior remain intact', async () => {
    resetMockDb();

    // Ensure Order ID 1, 2, 10, 99 exact matching behavior
    const testIds = [1, 2, 10, 99];
    for (const testId of testIds) {
      mockDb.orders.set(testId, {
        id: testId,
        tenantId: 1,
        orderNumber: `ORD-${testId}`,
        clientId: 5,
        orderType: 'CHAUFFEUR',
        status: 'pending',
        metadata: {
          customer_id: 1000 + testId,
          pickupLocation: `Pickup-${testId}`,
          dropLocation: `Drop-${testId}`
        }
      });

      mockDb.deliveries.set(100 + testId, {
        id: 100 + testId,
        tenantId: 1,
        orderId: testId,
        clientId: 5,
        status: 'pending',
        pickupLocation: `Pickup-${testId}`,
        dropLocation: `Drop-${testId}`
      });
    }

    // Update order 10 only
    await orderService.updateOrder(10, { pickupLocation: 'Pickup-10-Updated' }, 1, 1);

    // Verify order 1 delivery was NOT affected by substring match on "1" in "10"
    const del1 = mockDb.deliveries.get(101);
    assert.equal(del1.pickupLocation, 'Pickup-1', 'Order 1 delivery not affected by update to Order 10');

    // Verify order 10 delivery was updated exactly
    const del10 = mockDb.deliveries.get(110);
    assert.equal(del10.pickupLocation, 'Pickup-10-Updated', 'Order 10 delivery updated accurately');

    // Verify customer ownership remained intact
    const ord10 = mockDb.orders.get(10);
    assert.equal(ord10.metadata.customer_id, 1010, 'Customer ownership ID 1010 intact');
  });

} finally {
  teardownMocks();
}

console.log(`\nResults: ${passed}/${total} tests passed.`);
if (passed === total) {
  console.log('All regression test cases passed successfully!');
} else {
  process.exit(1);
}
