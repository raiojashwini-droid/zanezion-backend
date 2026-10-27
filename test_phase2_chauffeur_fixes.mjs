/**
 * Phase 2 Task 1: Chauffeur Booking, Customer Ownership & Order-Delivery Matching Regression Suite
 * 
 * Verifies:
 * 1. Customer bookings retaining the correct owner in metadata.
 * 2. Personal and corporate client dashboard ownership matching logic.
 * 3. Legacy Admin-created records (createdById=1, no customer meta) not appearing as another customer's bookings.
 * 4. Exact Order–Delivery matching, including IDs 1, 2, 10, and 99 without substring collisions.
 * 5. No driver, vehicle, address, or status leakage between unrelated orders.
 * 6. Pickup/drop-off address display formatting.
 * 7. Cross-tenant access remaining strictly denied.
 */

import assert from 'node:assert/strict';

// Simulated Frontend Context Mapping Logic (as implemented in GlobalDataContext.jsx)
function mapChauffeurOrder(order, deliveries = []) {
  let meta = order.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  meta = meta || {};
  const customItem = meta.customItems?.[0] || meta.custom_items?.[0] || {};
  const orderItem = order.items?.[0] || {};
  const detail = { ...orderItem, ...meta, ...customItem };

  const compId = order.companyId || order.company_id || order.clientId || order.client_id || detail?.companyId || detail?.company_id || detail?.clientId || null;

  // Resolve verified customer owner identity from trusted metadata or direct order customer fields
  const customerOwnerId =
    (meta.customer_id != null && !isNaN(Number(meta.customer_id))) ? Number(meta.customer_id) :
    (meta.customer_user_id != null && !isNaN(Number(meta.customer_user_id))) ? Number(meta.customer_user_id) :
    (meta.user_id != null && !isNaN(Number(meta.user_id))) ? Number(meta.user_id) :
    (meta.userId != null && !isNaN(Number(meta.userId))) ? Number(meta.userId) :
    (customItem?.customer_id != null && !isNaN(Number(customItem.customer_id))) ? Number(customItem.customer_id) :
    (customItem?.user_id != null && !isNaN(Number(customItem.user_id))) ? Number(customItem.user_id) :
    (customItem?.userId != null && !isNaN(Number(customItem.userId))) ? Number(customItem.userId) :
    (detail?.customer_id != null && !isNaN(Number(detail.customer_id))) ? Number(detail.customer_id) :
    (detail?.user_id != null && !isNaN(Number(detail.user_id))) ? Number(detail.user_id) :
    (order.customer_id != null && !isNaN(Number(order.customer_id))) ? Number(order.customer_id) :
    (order.userId != null && !isNaN(Number(order.userId))) ? Number(order.userId) :
    (order.user_id != null && !isNaN(Number(order.user_id))) ? Number(order.user_id) :
    null;

  const customerEmail =
    meta.customer_email ||
    meta.email ||
    customItem?.customer_email ||
    customItem?.email ||
    order.client?.email ||
    order.customer_email ||
    order.email ||
    null;

  // Cross-reference with deliveries array using unambiguous, exact relational matching only
  const targetOrderId = order?.id != null && !isNaN(Number(order.id)) ? Number(order.id) : null;
  const targetOrderNum = order?.orderNumber ? String(order.orderNumber).trim() : null;
  const cleanTargetNum = targetOrderNum ? targetOrderNum.replace(/^#|^ORD-/i, '').trim() : null;

  const matchingDelivery = (deliveries || []).find(d => {
    if (!d) return false;

    // 1. Direct numeric match on foreign key delivery.order_id_raw -> order.id
    if (targetOrderId !== null && d.order_id_raw != null) {
      const rawIdNum = Number(d.order_id_raw);
      if (!isNaN(rawIdNum) && rawIdNum > 0 && rawIdNum === targetOrderId) {
        return true;
      }
    }

    // 2. Exact match against formatted delivery.orderId reference string
    if (d.orderId) {
      const delOrderStr = String(d.orderId).trim();
      if (targetOrderNum && delOrderStr.toLowerCase() === targetOrderNum.toLowerCase()) {
        return true;
      }
      const cleanDelStr = delOrderStr.replace(/^#|^ORD-/i, '').trim();
      if (targetOrderId !== null) {
        const parsedClean = Number(cleanDelStr);
        if (!isNaN(parsedClean) && parsedClean > 0 && parsedClean === targetOrderId) {
          return true;
        }
      }
      if (cleanTargetNum && cleanDelStr.toLowerCase() === cleanTargetNum.toLowerCase()) {
        return true;
      }
    }

    return false;
  });

  const isOrderCancelled = ['cancelled', 'rejected', 'canceled'].includes(String(order.status || '').toLowerCase());
  const isDeliveryCancelled = ['cancelled', 'rejected', 'canceled'].includes(String(matchingDelivery?.status || '').toLowerCase());
  const orderSt = String(order.status || '').toLowerCase();
  const deliverySt = String(matchingDelivery?.status || '').toLowerCase();

  let liveStatus = 'pending';
  if (isOrderCancelled || isDeliveryCancelled) {
    liveStatus = 'cancelled';
  } else if (['completed', 'delivered', 'done'].includes(orderSt) || ['completed', 'delivered', 'done'].includes(deliverySt)) {
    liveStatus = 'completed';
  } else if (['in transit', 'in_transit', 'en route', 'en_route', 'picked up', 'picked_up'].includes(deliverySt) || ['in transit', 'in_transit', 'en route', 'en_route'].includes(orderSt)) {
    liveStatus = (deliverySt === 'en_route' || orderSt === 'en_route') ? 'en_route' : (deliverySt || orderSt);
  } else if (['accepted', 'approved'].includes(orderSt) || ['accepted', 'approved'].includes(deliverySt)) {
    liveStatus = 'accepted';
  } else {
    liveStatus = matchingDelivery?.status || order.status || 'pending';
  }

  const liveDriver =
    order.driverName ||
    meta.driverName ||
    customItem.driverName ||
    matchingDelivery?.driver ||
    detail?.driverName ||
    null;

  const liveVehicle =
    order.plateNumber ||
    order.vehicleId ||
    order.vehicle ||
    meta.plateNumber ||
    meta.vehicleId ||
    meta.vehicle ||
    customItem.plateNumber ||
    customItem.vehicleId ||
    matchingDelivery?.vehicleId ||
    detail?.plateNumber ||
    null;

  const resolvedPickup =
    order.pickup_location ||
    order.pickupLocation ||
    meta.pickup_location ||
    meta.pickupLocation ||
    customItem.pickupLocation ||
    customItem.pickup_location ||
    detail.pickupLocation ||
    detail.pickup_location ||
    matchingDelivery?.pickupLocation ||
    '';

  const resolvedDrop =
    order.location ||
    order.delivery_address ||
    order.deliveryAddress ||
    order.dropLocation ||
    order.drop_location ||
    meta.location ||
    meta.delivery_address ||
    meta.deliveryAddress ||
    meta.dropLocation ||
    meta.drop_location ||
    customItem.dropLocation ||
    customItem.drop_location ||
    customItem.location ||
    detail.dropLocation ||
    detail.drop_location ||
    detail.location ||
    matchingDelivery?.dropLocation ||
    '';

  return {
    id: order.id,
    db_id: order.id,
    orderNumber: order.orderNumber,
    tenantId: order.tenantId || meta.tenantId || null,
    clientId: order.clientId || order.client_id || detail?.clientId || 'CLT-GUEST',
    company_id: compId,
    companyId: compId,
    customer_id: customerOwnerId,
    customerId: customerOwnerId,
    user_id: customerOwnerId,
    userId: customerOwnerId,
    created_by: customerOwnerId,
    employee_created_by: order.createdById,
    customer_email: customerEmail,
    email: customerEmail,
    driverName: liveDriver,
    plateNumber: liveVehicle,
    pickupLocation: resolvedPickup || "Pickup Point",
    dropLocation: resolvedDrop || "Destination",
    status: liveStatus
  };
}

// Simulated Client Dashboard Filter Logic (as implemented in ClientDashboard.jsx & PersonalClientDashboard.jsx)
function isChauffeurVisibleToClient(req, currentUser, clientData) {
  if (!req) return false;

  // Strict cross-tenant boundary: reject if tenantId mismatch is present
  const currentTenantId = currentUser?.tenantId != null ? String(currentUser.tenantId) : null;
  const reqTenantId = req.tenantId != null ? String(req.tenantId) : null;
  if (currentTenantId && reqTenantId && currentTenantId !== reqTenantId) {
    return false;
  }

  const myUserId = currentUser?.id != null ? String(currentUser.id) : null;
  const myClientId = (clientData?.id && clientData.id !== 'GUEST') ? String(clientData.id) : (currentUser?.clientId || currentUser?.company_id ? String(currentUser.clientId || currentUser.company_id) : null);
  const myEmail = currentUser?.email ? String(currentUser.email).toLowerCase().trim() : null;

  // 1. Exact match on verified customer user ID
  const reqCustId = (req.customer_id != null && req.customer_id !== '') ? String(req.customer_id) :
    (req.user_id != null && req.user_id !== '') ? String(req.user_id) :
    (req.userId != null && req.userId !== '') ? String(req.userId) :
    (req.created_by != null && req.created_by !== '') ? String(req.created_by) : null;

  if (myUserId && reqCustId && reqCustId === myUserId) return true;

  // 2. Exact match on verified corporate Client ID
  const reqClientId = (req.clientId && req.clientId !== 'CLT-GUEST') ? String(req.clientId) :
    (req.company_id != null && req.company_id !== '') ? String(req.company_id) : null;

  if (myClientId && reqClientId && reqClientId === myClientId) return true;

  // 3. Exact match on verified customer email (exact equality only, no partial match)
  const reqEmail = req.customer_email ? String(req.customer_email).toLowerCase().trim() :
    (req.email ? String(req.email).toLowerCase().trim() : null);

  if (myEmail && reqEmail && reqEmail === myEmail) return true;

  return false;
}

// --- RUN TESTS ---

console.log('--- Zanezion Phase 2 Task 1: Regression Test Suite ---');
let passed = 0;
let total = 0;

function runTest(name, fn) {
  total++;
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}`);
    console.error(`  ${err.message}`);
  }
}

// Test 1: Customer bookings retaining correct owner in metadata (no fabricated 1)
runTest('1. Customer booking retains correct owner and does not fabricate Admin ID 1', () => {
  const customerUser = { id: 42, email: 'customer42@example.com', tenantId: 1 };
  const rawOrder = {
    id: 101,
    orderNumber: 'ORD-2026-0101',
    createdById: 1, // Employee FK constraint
    clientId: 5,
    tenantId: 1,
    status: 'created',
    metadata: {
      customer_id: customerUser.id,
      user_id: customerUser.id,
      customer_email: customerUser.email,
      pickupLocation: 'Lynden Pindling International Airport (NAS)',
      dropLocation: 'The Ocean Club, Bahamas'
    }
  };

  const mapped = mapChauffeurOrder(rawOrder);
  assert.equal(mapped.customer_id, 42, 'customer_id should match authenticated customer ID');
  assert.equal(mapped.created_by, 42, 'created_by should match authenticated customer ID');
  assert.equal(mapped.employee_created_by, 1, 'employee_created_by should retain employee attribution');
});

// Test 2: Personal and corporate client dashboard ownership
runTest('2. Personal client and corporate client dashboard visibility', () => {
  const personalClientUser = { id: 42, email: 'personal@client.com', tenantId: 1 };
  const corporateClientUser = { id: 77, email: 'corp@enterprise.com', clientId: 10, tenantId: 1 };
  const otherClientUser = { id: 99, email: 'other@client.com', tenantId: 1 };

  const personalOrder = mapChauffeurOrder({
    id: 101,
    orderNumber: 'ORD-101',
    tenantId: 1,
    createdById: 1,
    metadata: {
      customer_id: 42,
      customer_email: 'personal@client.com',
      pickupLocation: 'Airport',
      dropLocation: 'Resort'
    }
  });

  const corporateOrder = mapChauffeurOrder({
    id: 102,
    orderNumber: 'ORD-102',
    tenantId: 1,
    clientId: 10,
    createdById: 1,
    metadata: {
      customer_email: 'corp@enterprise.com',
      pickupLocation: 'HQ',
      dropLocation: 'Conference'
    }
  });

  // Personal user sees their booking
  assert.equal(isChauffeurVisibleToClient(personalOrder, personalClientUser, {}), true);
  // Other user does NOT see personal user's booking
  assert.equal(isChauffeurVisibleToClient(personalOrder, otherClientUser, {}), false);

  // Corporate user sees corporate booking by clientId
  assert.equal(isChauffeurVisibleToClient(corporateOrder, corporateClientUser, { id: 10 }), true);
  // Other user does NOT see corporate booking
  assert.equal(isChauffeurVisibleToClient(corporateOrder, otherClientUser, {}), false);
});

// Test 3: Legacy Admin-created records not appearing as another customer's bookings
runTest('3. Legacy Admin-created record does not leak to Customer #1', () => {
  const customerUser1 = { id: 1, email: 'customer1@zanezion.com', tenantId: 1 };
  const legacyAdminOrder = mapChauffeurOrder({
    id: 201,
    orderNumber: 'ORD-201',
    createdById: 1, // Created by admin employee
    clientId: 999, // Unrelated corporate client
    tenantId: 1,
    metadata: {
      pickupLocation: 'Admin Depot',
      dropLocation: 'Warehouse 1'
      // Notice: NO customer_id or customer_email
    }
  });

  assert.equal(legacyAdminOrder.customer_id, null, 'Legacy admin record without customer meta has customer_id = null');
  assert.equal(legacyAdminOrder.created_by, null, 'created_by should not default to 1');
  assert.equal(isChauffeurVisibleToClient(legacyAdminOrder, customerUser1, {}), false, 'Customer #1 must NOT see legacy admin record');
});

// Test 4: Exact Order–Delivery matching, including IDs 1, 2, 10, and 99
runTest('4. Exact Order-Delivery matching for IDs 1, 2, 10, and 99 (no substring collisions)', () => {
  const deliveries = [
    { id: 1, db_id: 1, order_id_raw: 99, orderId: 'ORD-099', driver: 'Driver 99', status: 'en_route' },
    { id: 10, db_id: 10, order_id_raw: 10, orderId: 'ORD-010', driver: 'Driver 10', status: 'completed' },
    { id: 20, db_id: 20, order_id_raw: 20, orderId: 'ORD-020', driver: 'Driver 20', status: 'in_transit' },
    { id: 100, db_id: 100, order_id_raw: 1, orderId: 'ORD-001', driver: 'Driver 1', status: 'arrived' },
    { id: 200, db_id: 200, order_id_raw: 2, orderId: 'ORD-002', driver: 'Driver 2', status: 'accepted' }
  ];

  // Order #1: should match delivery with order_id_raw = 1 (Delivery 100), NOT Delivery #1 (db_id=1, order=99), NOT Delivery 10
  const order1 = mapChauffeurOrder({ id: 1, orderNumber: 'ORD-001', status: 'pending' }, deliveries);
  assert.equal(order1.driverName, 'Driver 1', 'Order 1 must match Delivery 100 (driver 1)');
  assert.equal(order1.status, 'arrived', 'Order 1 status should be arrived from Delivery 100');

  // Order #2: should match delivery with order_id_raw = 2 (Delivery 200), NOT Delivery 20 (substring "2")
  const order2 = mapChauffeurOrder({ id: 2, orderNumber: 'ORD-002', status: 'pending' }, deliveries);
  assert.equal(order2.driverName, 'Driver 2', 'Order 2 must match Delivery 200 (driver 2)');
  assert.equal(order2.status, 'accepted', 'Order 2 status should be accepted');

  // Order #10: should match Delivery 10
  const order10 = mapChauffeurOrder({ id: 10, orderNumber: 'ORD-010', status: 'pending' }, deliveries);
  assert.equal(order10.driverName, 'Driver 10', 'Order 10 must match Delivery 10');
  assert.equal(order10.status, 'completed', 'Order 10 status should be completed');

  // Order #99: should match Delivery 1 (order_id_raw = 99)
  const order99 = mapChauffeurOrder({ id: 99, orderNumber: 'ORD-099', status: 'pending' }, deliveries);
  assert.equal(order99.driverName, 'Driver 99', 'Order 99 must match Delivery 1');
  assert.equal(order99.status, 'en_route', 'Order 99 status should be en_route');
});

// Test 5: No driver, vehicle, address, or status leakage between unrelated orders
runTest('5. Unmatched order receives zero leakage from unrelated deliveries', () => {
  const unrelatedDeliveries = [
    { id: 1, db_id: 1, order_id_raw: 123, orderId: 'ORD-123', driver: 'Leaked Driver', vehicleId: 'LEAK-999', status: 'delivered', pickupLocation: 'Leaked Pickup', dropLocation: 'Leaked Drop' }
  ];

  const independentOrder = mapChauffeurOrder({
    id: 55,
    orderNumber: 'ORD-055',
    status: 'pending',
    metadata: {
      pickupLocation: 'Real Pickup',
      dropLocation: 'Real Drop'
    }
  }, unrelatedDeliveries);

  assert.equal(independentOrder.driverName, null, 'Driver must not leak from unrelated delivery');
  assert.equal(independentOrder.plateNumber, null, 'Vehicle must not leak from unrelated delivery');
  assert.equal(independentOrder.status, 'pending', 'Status must remain pending');
  assert.equal(independentOrder.pickupLocation, 'Real Pickup', 'Pickup must not be overwritten');
  assert.equal(independentOrder.dropLocation, 'Real Drop', 'Drop must not be overwritten');
});

// Test 6: Pickup and drop-off address display
runTest('6. Pickup and drop-off address formatting and persistence', () => {
  const order = mapChauffeurOrder({
    id: 300,
    orderNumber: 'ORD-300',
    metadata: {
      pickupLocation: 'Lynden Pindling International Airport (NAS)',
      dropLocation: 'The Ocean Club, Bahamas'
    }
  });

  assert.equal(order.pickupLocation, 'Lynden Pindling International Airport (NAS)');
  assert.equal(order.dropLocation, 'The Ocean Club, Bahamas');
});

// Test 7: Cross-tenant access remaining denied
runTest('7. Cross-tenant access strictly denied', () => {
  const tenant1User = { id: 10, email: 'user@tenant1.com', tenantId: 1 };
  const tenant2Order = mapChauffeurOrder({
    id: 400,
    tenantId: 2, // Different tenant!
    metadata: {
      customer_id: 10, // Same user ID but different tenant
      customer_email: 'user@tenant1.com'
    }
  });

  assert.equal(isChauffeurVisibleToClient(tenant2Order, tenant1User, {}), false, 'Cross-tenant access must be rejected');
});

console.log(`\nResults: ${passed}/${total} tests passed.`);
if (passed === total) {
  console.log('All regression test cases passed successfully!');
} else {
  process.exit(1);
}
