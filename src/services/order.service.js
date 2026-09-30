import * as orderRepo from '../repositories/order.repository.js';
import * as clientRepo from '../repositories/client.repository.js';
import * as employeeRepo from '../repositories/employee.repository.js';
import prisma from '../config/db.js';
import AppError from '../utils/AppError.js';
import { logAudit } from '../utils/audit.js';

// --- Order Reservation Engine ---

const validateAndReserveStock = async (tx, items) => {
  const itemsArray = items || [];
  for (const item of itemsArray) {
    const stock = await tx.inventoryStock.findUnique({
      where: { warehouseId_itemId: { warehouseId: item.warehouseId, itemId: item.itemId } }
    });

    if (!stock) {
      throw new AppError(`Stock record not found for Item ${item.itemId} in Warehouse ${item.warehouseId}`, 400);
    }

    const availableQuantity = stock.quantity - stock.reservedQuantity;
    if (availableQuantity < item.quantity) {
      throw new AppError(`Insufficient stock for Item ${item.itemId}. Available: ${availableQuantity}, Requested: ${item.quantity}`, 400);
    }

    // Reserve stock
    await tx.inventoryStock.update({
      where: { id: stock.id },
      data: { reservedQuantity: { increment: item.quantity } }
    });
  }
};

const releaseReservedStock = async (tx, items) => {
  const itemsArray = items || [];
  for (const item of itemsArray) {
    const stock = await tx.inventoryStock.findUnique({
      where: { warehouseId_itemId: { warehouseId: item.warehouseId, itemId: item.itemId } }
    });

    if (stock) {
      // Ensure we don't drop below 0 by releasing too much (sanity check)
      const decrementVal = Math.min(stock.reservedQuantity, item.quantity);
      await tx.inventoryStock.update({
        where: { id: stock.id },
        data: { reservedQuantity: { decrement: decrementVal } }
      });
    }
  }
};

// --- Order Methods ---

export const createOrder = async (data, performerId, tenantId) => {
  const { items, ...orderData } = data;

  let client = null;

  // If order is created by a customer, strictly prioritize their dedicated client record on their tenant
  if (performerId) {
    const user = await prisma.user.findUnique({
      where: { id: Number(performerId) },
      include: { role: true }
    });
    const roleName = String(user?.role?.name || user?.role || '').toUpperCase();
    if (['CUSTOMER', 'INDIVIDUAL_CLIENT'].includes(roleName) && user?.email) {
      client = await prisma.client.findFirst({
        where: { email: user.email, tenantId: user.tenantId }
      }) || await prisma.client.findFirst({
        where: { email: user.email }
      });
      if (client) {
        orderData.clientId = client.id;
      }
    }
  }

  if (!client && data.clientId) {
    const cid = Number(data.clientId);
    if (!isNaN(cid)) {
      client = await clientRepo.findClientById(cid);
      if (!client) {
        // The provided cid might be a User ID instead of a Client ID
        const userForClient = await prisma.user.findUnique({ where: { id: cid } });
        if (userForClient?.email) {
          client = await prisma.client.findFirst({
            where: { email: userForClient.email, ...(userForClient.tenantId ? { tenantId: userForClient.tenantId } : {}) }
          });
          if (!client) {
            client = await prisma.client.findFirst({
              where: { email: userForClient.email }
            });
          }
          if (!client && userForClient.name) {
            client = await prisma.client.findFirst({
              where: { companyName: userForClient.name, ...(userForClient.tenantId ? { tenantId: userForClient.tenantId } : {}) }
            });
          }
        }
      }
    }
  }

  // If still no client found, try finding client matching performerId (logged in user)
  if (!client && performerId) {
    const user = await prisma.user.findUnique({ where: { id: Number(performerId) } });
    if (user && user.email) {
      client = await prisma.client.findFirst({
        where: { email: user.email }
      });
      // If client profile doesn't exist for this user, auto-create a dedicated client record with user's real name
      if (!client) {
        const clientCode = `CLT-${Date.now().toString().slice(-6)}`;
        client = await prisma.client.create({
          data: {
            tenantId: tenantId || 1,
            clientCode,
            companyName: user.name ? (user.name.includes('(Personal Client)') ? user.name : `${user.name} (Personal Client)`) : (data.client || 'Personal Client'),
            contactPerson: user.name || 'Personal Client',
            email: user.email,
            phone: user.phone || 'N/A',
            status: 'active',
            clientType: 'Personal'
          }
        });
      }
    }
  }

  if (!client) {
    client = await prisma.client.findFirst({ where: { status: 'active' } }) || await prisma.client.findFirst();
  }

  if (!client) {
    throw new AppError('Selected client does not exist', 404);
  }

  orderData.clientId = client.id;
  const orderTenantId = client ? Number(client.tenantId) : (tenantId || 1);

  // Auto-resolve default warehouse if missing on items
  let defaultWarehouse = await prisma.warehouse.findFirst({ where: { tenantId: orderTenantId } });
  if (!defaultWarehouse) {
    defaultWarehouse = await prisma.warehouse.findFirst();
  }

  const validOrderItems = [];
  const customItems = [];

  if (items && Array.isArray(items)) {
    for (const item of items) {
      const rawItemId = item.itemId || item.id;
      const parsedItemId = rawItemId != null && !isNaN(Number(rawItemId)) ? Number(rawItemId) : null;
      const rawWhId = item.warehouseId || item.warehouse_id;
      const parsedWhId = rawWhId != null && !isNaN(Number(rawWhId)) ? Number(rawWhId) : (defaultWarehouse?.id || 1);

      let dbItemExists = false;
      let targetItemId = parsedItemId;
      if (parsedItemId) {
        let dbItem = await prisma.item.findUnique({ where: { id: parsedItemId } });
        if (dbItem) {
          if (item.name && typeof item.name === 'string' && item.name.trim() && dbItem.name.trim().toLowerCase() !== item.name.trim().toLowerCase()) {
            const nameMatch = await prisma.item.findFirst({
              where: { name: item.name.trim() }
            });
            if (nameMatch) {
              targetItemId = nameMatch.id;
              dbItem = nameMatch;
            }
          }
          dbItemExists = true;
        } else if (item.name && typeof item.name === 'string' && item.name.trim()) {
          const nameMatch = await prisma.item.findFirst({
            where: { name: item.name.trim() }
          });
          if (nameMatch) {
            targetItemId = nameMatch.id;
            dbItemExists = true;
          }
        }
      } else if (item.name && typeof item.name === 'string' && item.name.trim()) {
        const nameMatch = await prisma.item.findFirst({
          where: { name: item.name.trim() }
        });
        if (nameMatch) {
          targetItemId = nameMatch.id;
          dbItemExists = true;
        }
      }

      if (targetItemId && parsedWhId && dbItemExists) {
        validOrderItems.push({
          itemId: targetItemId,
          warehouseId: parsedWhId,
          quantity: Number(item.quantity || item.qty || 1),
          unitPrice: Number(item.unitPrice || item.price || 0)
        });
      } else {
        customItems.push(item);
      }
    }
  }

  const existingMeta = typeof orderData.metadata === 'string'
    ? (JSON.parse(orderData.metadata) || {})
    : (orderData.metadata || {});

  const passedTotal = Number(
    data.totalAmount ||
    data.total_amount ||
    data.total ||
    data.estimated_total ||
    data.amount ||
    data.chauffeurFee ||
    data.chauffeur_fee ||
    data.fee ||
    existingMeta.chauffeurFee ||
    existingMeta.chauffeur_fee ||
    existingMeta.total_amount ||
    (customItems[0] && (customItems[0].chauffeurFee || customItems[0].chauffeur_fee || customItems[0].price || customItems[0].total)) ||
    0
  );

  const isChauffeurOrder = String(orderData.orderType || data.type || '').toUpperCase() === 'CHAUFFEUR';
  const isMarketplaceOrder = ['MARKETPLACE', 'MARKET_ORDER', 'CUSTOM', 'PURCHASE'].includes(String(orderData.orderType || data.type || '').toUpperCase());
  if (isChauffeurOrder) {
    const sType = data.serviceType || existingMeta.serviceType || 'One Way';
    const days = parseInt(data.numberOfDays || data.dailyDays || existingMeta.numberOfDays || existingMeta.dailyDays || 1, 10) || 1;
    const qtyMultiplier = sType === 'Round Trip' ? 2 : (sType === 'Daily Service' ? days : 1);
    const baseUnitPrice = Number(data.unitPrice || data.price || existingMeta.unitPrice || 120) || 120;
    const computedChauffeurTotal = baseUnitPrice * qtyMultiplier;

    if (!passedTotal || (sType === 'Daily Service' && days > 1 && passedTotal <= baseUnitPrice * 1.5) || (sType === 'Round Trip' && passedTotal <= baseUnitPrice * 1.5)) {
      orderData.totalAmount = computedChauffeurTotal;
    } else {
      orderData.totalAmount = passedTotal;
    }
  } else if (validOrderItems.length > 0) {
    const calcTotal = validOrderItems.reduce((acc, i) => acc + (i.quantity * i.unitPrice), 0);
    orderData.totalAmount = calcTotal > 0 ? calcTotal : passedTotal;
  } else {
    orderData.totalAmount = passedTotal;
  }

  const metaCustomItems = Array.isArray(existingMeta.customItems) ? existingMeta.customItems : [];
  const itemsToSave = customItems.length > 0 ? customItems : (items || []);
  const customItem = (customItems && customItems[0]) || (items && items[0]) || (existingMeta && existingMeta.customItems && existingMeta.customItems[0]) || {};

  const dropLocation = data.dropLocation || data.drop_location || data.location || customItem.dropLocation || existingMeta.dropLocation || '';
  const pickupLocation = data.pickupLocation || data.pickup_location || customItem.pickupLocation || existingMeta.pickupLocation || '';
  const totalDistance = data.totalDistance || data.total_distance || customItem.totalDistance || existingMeta.totalDistance || '';

  if (isChauffeurOrder) {
    // Determine client name fallback for guestName / passengerName if not explicitly provided
    const resolvedClientName = client ? (client.companyName || client.contactPerson || client.name) : (orderData.clientName || 'Guest Client');
    const rawPassengerName = data.passengerName || data.passenger_name || data.guestName || data.guest_name || customItem.passengerName || customItem.passenger_name || customItem.guestName || customItem.guest_name || existingMeta.passengerName || existingMeta.guestName;
    const passengerName = (rawPassengerName && String(rawPassengerName).trim() && String(rawPassengerName).toLowerCase() !== 'personal client')
      ? String(rawPassengerName).trim()
      : (resolvedClientName && resolvedClientName.toLowerCase() !== 'personal client' ? resolvedClientName : (customItem.passengerName || customItem.guestName || rawPassengerName || resolvedClientName));

    const numberOfPassengers = Number(data.numberOfPassengers || data.passengers || data.passengerCount || customItem.numberOfPassengers || customItem.passengers || customItem.passengerCount || existingMeta.numberOfPassengers || existingMeta.passengers || 1);
    const rawAmenities = data.amenities || customItem.amenities || existingMeta.amenities || [];
    const amenitiesArray = Array.isArray(rawAmenities)
      ? rawAmenities
      : (typeof rawAmenities === 'string' && rawAmenities.trim() ? rawAmenities.split(',').map(s => s.trim()) : []);

    const amenitiesLower = amenitiesArray.map(a => String(a).toLowerCase());
    const wifi = (data.wifi === 'Yes' || customItem.wifi === 'Yes' || existingMeta.wifi === 'Yes' || amenitiesLower.some(a => a.includes('wifi'))) ? 'Yes' : 'No';
    const refreshments = (data.refreshments === 'Yes' || customItem.refreshments === 'Yes' || existingMeta.refreshments === 'Yes' || amenitiesLower.some(a => a.includes('refreshment'))) ? 'Yes' : 'No';
    const carSeat = (data.carSeat === 'Yes' || data.car_seat === 'Yes' || customItem.carSeat === 'Yes' || customItem.car_seat === 'Yes' || existingMeta.carSeat === 'Yes' || existingMeta.car_seat === 'Yes' || amenitiesLower.some(a => a.includes('car seat') || a.includes('baby'))) ? 'Yes' : 'No';
    const stops = data.stops || customItem.stops || existingMeta.stops || 'No';
    const stopLocations = data.stopLocations || data.stop_locations || customItem.stopLocations || existingMeta.stopLocations || null;
    const rawBags = Number(data.bags !== undefined ? data.bags : (customItem.bags !== undefined ? customItem.bags : (existingMeta.bags !== undefined ? existingMeta.bags : 0)));
    const luggage = (data.luggage && data.luggage !== 'No') ? data.luggage : (customItem.luggage && customItem.luggage !== 'No' ? customItem.luggage : (existingMeta.luggage && existingMeta.luggage !== 'No' ? existingMeta.luggage : (rawBags > 0 ? `Yes — ${rawBags} bag(s)` : 'No')));
    const bags = rawBags;
    const serviceType = data.serviceType || customItem.serviceType || existingMeta.serviceType || 'One Way';
    const returnDate = data.returnDate || customItem.returnDate || existingMeta.returnDate || null;
    const returnTime = data.returnTime || customItem.returnTime || existingMeta.returnTime || null;
    const pickupTime = data.pickupTime || customItem.pickupTime || existingMeta.pickupTime || null;

    orderData.metadata = {
      ...existingMeta,
      numberOfPassengers,
      passengers: numberOfPassengers,
      passengerCount: numberOfPassengers,
      passengerName,
      guestName: passengerName,
      luggage: (luggage === 'Yes' && bags > 0) ? `Yes — ${bags} bag(s)` : luggage,
      bags,
      stops,
      stopLocations,
      wifi,
      refreshments,
      carSeat,
      amenities: amenitiesArray,
      serviceType,
      returnDate,
      returnTime,
      pickupTime,
      pickupLocation,
      dropLocation,
      location: dropLocation,
      totalDistance,
      customItems: metaCustomItems.length > 0 ? metaCustomItems : itemsToSave
    };
  } else {
    orderData.metadata = {
      ...existingMeta,
      pickupLocation: pickupLocation || null,
      dropLocation: dropLocation || null,
      location: dropLocation || null,
      totalDistance: totalDistance || null,
      customItems: metaCustomItems.length > 0 ? metaCustomItems : itemsToSave
    };
  }

  const employee = await prisma.employee.findUnique({ where: { userId: performerId } });
  orderData.createdById = employee ? employee.id : 1;
  orderData.status = data.status || 'created';

  const typeStrLower = String(data.orderType || data.type || orderData.orderType || '').toLowerCase();
  if (isMarketplaceOrder || typeStrLower.includes('marketplace') || typeStrLower.includes('delivery')) {
    orderData.orderType = 'Delivery';
  }

  const newOrder = await orderRepo.createOrder(orderData, validOrderItems, orderTenantId);

  await logAudit({
    module: 'ORDERS',
    action: 'CREATE',
    description: `Created Order ${newOrder.orderNumber} for Client ${client.companyName}`,
    newValue: newOrder,
    performedBy: performerId
  });

  try {
    await prisma.notification.create({
      data: {
        title: 'New Order Created',
        message: `Order #${newOrder.id} (${newOrder.orderNumber}) placed by ${client.companyName}`,
        type: 'ORDER_CREATED',
        userId: performerId
      }
    });
  } catch (notifErr) {
    // Non-blocking notification dispatch
  }

  return newOrder;
};

export const getOrders = async (tenantId, query) => {
  return await orderRepo.findAllOrders(tenantId, query);
};

export const getOrderById = async (id, tenantId) => {
  const order = await orderRepo.findOrderById(id);
  if (!order) {
    throw new AppError('Order not found', 404);
  }
  return order;
};

export const updateOrderStatus = async (id, status, tenantId, performerId, remarks, performerRole) => {
  const order = await getOrderById(id, tenantId);
  const realOrderId = order.id;

  if (order.status === 'cancelled') {
    throw new AppError('Cannot update a cancelled order', 400);
  }

  const normStatus = String(status).toLowerCase().replace(/\s+/g, '_');

  // --- Build workflow history entry ---
  const currentMeta = typeof order.metadata === 'string'
    ? JSON.parse(order.metadata)
    : (order.metadata || {});

  const currentStatus = String(order.status || currentMeta.chauffeur_status || '').toLowerCase().replace(/\s+/g, '_');

  const isChauffeur = order.orderType === 'CHAUFFEUR' || 
                      order.missionType === 'CHAUFFEUR' || 
                      String(currentMeta.missionType || '').toUpperCase() === 'CHAUFFEUR' || 
                      String(currentMeta.orderType || '').toUpperCase() === 'CHAUFFEUR' ||
                      currentMeta.serviceType !== undefined ||
                      currentMeta.chauffeur_status !== undefined ||
                      Boolean(currentMeta.pickupLocation && currentMeta.dropLocation);

  // Controlled status transitions for Chauffeur lifecycle:
  // Pending → Accepted → En Route → Arrived → Completed
  if (isChauffeur) {
    if (['completed', 'delivered'].includes(currentStatus)) {
      throw new AppError('Chauffeur trip is already completed and cannot undergo further status transitions.', 400);
    }

    if (['en_route', 'in_transit'].includes(currentStatus)) {
      // Prevent jumping straight to completed without Arrived
      if (['completed', 'delivered'].includes(normStatus)) {
        throw new AppError("Invalid transition: Chauffeur trip must reach 'arrived' status before it can be marked as completed.", 400);
      }
      // Prevent reverting to earlier states
      if (['accepted', 'assigned', 'pending', 'rejected'].includes(normStatus)) {
        throw new AppError(`Invalid transition: Cannot revert in-progress chauffeur trip from '${currentStatus}' to '${normStatus}'.`, 400);
      }
      // Exceptional cancellation restriction
      if (['cancelled', 'canceled', 'rejected'].includes(normStatus)) {
        const isAdmin = ['SUPER_ADMIN', 'SUPERADMIN', 'ADMIN'].includes(String(performerRole || '').toUpperCase());
        if (!isAdmin) {
          throw new AppError('Only authorized Admin users can perform exceptional cancellation of an in-progress chauffeur trip.', 403);
        }
        if (!remarks || !remarks.trim()) {
          throw new AppError('A mandatory cancellation reason is required for exceptional cancellation of an in-progress chauffeur trip.', 400);
        }
      }
    }

    if (currentStatus === 'arrived') {
      // Prevent reverting to earlier states
      if (['en_route', 'in_transit', 'accepted', 'assigned', 'pending', 'rejected'].includes(normStatus)) {
        throw new AppError(`Invalid transition: Cannot revert arrived chauffeur trip to '${normStatus}'.`, 400);
      }
      // Exceptional cancellation restriction
      if (['cancelled', 'canceled', 'rejected'].includes(normStatus)) {
        const isAdmin = ['SUPER_ADMIN', 'SUPERADMIN', 'ADMIN'].includes(String(performerRole || '').toUpperCase());
        if (!isAdmin) {
          throw new AppError('Only authorized Admin users can perform exceptional cancellation of an arrived chauffeur trip.', 403);
        }
        if (!remarks || !remarks.trim()) {
          throw new AppError('A mandatory cancellation reason is required for exceptional cancellation of an arrived chauffeur trip.', 400);
        }
      }
    }

    if (['accepted', 'assigned', 'approved'].includes(currentStatus)) {
      // Cannot jump to arrived or completed without en_route
      if (['arrived', 'completed', 'delivered'].includes(normStatus)) {
        throw new AppError("Invalid transition: Chauffeur trip must start ('en_route') before reaching 'arrived' or 'completed'.", 400);
      }
    }
  }

  const existingHistory = Array.isArray(currentMeta.workflowHistory) ? currentMeta.workflowHistory : [];

  const historyEntry = {
    department: normStatus,
    previousDepartment: String(order.status || '').toLowerCase(),
    movedBy: performerId,
    movedAt: new Date().toISOString(),
    ...(remarks ? { remarks } : {})
  };

  const newMetadata = {
    ...currentMeta,
    status: normStatus,
    chauffeur_status: normStatus,
    currentDepartment: normStatus,
    workflowHistory: [...existingHistory, historyEntry]
  };

  let updatedOrder;

  await prisma.$transaction(async (tx) => {
    // If transitioning TO approved, Reserve Stock
    if (normStatus === 'approved') {
      await validateAndReserveStock(tx, order.items);
    }

    // If transitioning FROM approved TO cancelled, Release Stock
    if (order.status === 'approved' && normStatus === 'cancelled') {
      await releaseReservedStock(tx, order.items);
    }

    // Update order status + persist new metadata with workflow history
    updatedOrder = await tx.order.update({
      where: { id: realOrderId },
      data: {
        status: normStatus,
        metadata: newMetadata
      }
    });

    // If order is completed/delivered, sync associated deliveries
    if (['completed', 'delivered'].includes(normStatus)) {
      await tx.delivery.updateMany({
        where: { orderId: realOrderId },
        data: { status: 'delivered' }
      }).catch(() => null);
    } else if (normStatus === 'arrived') {
      await tx.delivery.updateMany({
        where: { orderId: realOrderId },
        data: { status: 'arrived' }
      }).catch(() => null);
    } else if (['in_transit', 'en_route', 'dispatched'].includes(normStatus)) {
      await tx.delivery.updateMany({
        where: { orderId: realOrderId },
        data: { status: normStatus === 'en_route' ? 'en_route' : 'in_transit' }
      }).catch(() => null);
    } else if (['assigned', 'accepted'].includes(normStatus)) {
      await tx.delivery.updateMany({
        where: { orderId: realOrderId },
        data: { status: 'assigned' }
      }).catch(() => null);
    } else if (['cancelled', 'rejected', 'canceled'].includes(normStatus)) {
      await tx.delivery.updateMany({
        where: { orderId: realOrderId },
        data: { status: 'cancelled' }
      }).catch(() => null);
      await tx.mission.updateMany({
        where: { orderId: realOrderId },
        data: { status: 'cancelled' }
      }).catch(() => null);
    }
  });

  await logAudit({
    module: 'ORDERS',
    action: 'STATUS_CHANGE',
    description: `Order ${order.orderNumber} forwarded from ${order.status} → ${status}`,
    oldValue: { status: order.status },
    newValue: { status, workflowEntry: historyEntry },
    performedBy: performerId
  });

  const { metadata, ...rest } = updatedOrder;
  const metadataObj = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata || {});
  return {
    ...metadataObj,
    ...rest,
    status,
    metadata: metadataObj
  };
};


export const updateOrder = async (id, data, tenantId, performerId) => {
  const order = await getOrderById(id, tenantId);
  const { items, ...orderData } = data;

  const incomingItems = (items && Array.isArray(items) && items.length > 0)
    ? items
    : ((data.customItems && Array.isArray(data.customItems) && data.customItems.length > 0)
      ? data.customItems
      : ((data.manifestItems && Array.isArray(data.manifestItems) && data.manifestItems.length > 0)
        ? data.manifestItems
        : null));

  let formattedCustomItems = [];
  if (incomingItems && incomingItems.length > 0) {
    formattedCustomItems = incomingItems.map((itm, idx) => {
      const name = itm.name || itm.item?.name || itm.itemName || itm.title || itm.description || `Item ${idx + 1}`;
      const qty = parseInt(itm.qty != null ? itm.qty : (itm.quantity != null ? itm.quantity : 1), 10) || 1;
      const price = parseFloat(itm.price != null ? itm.price : (itm.unitPrice != null ? itm.unitPrice : 0)) || 0;
      return {
        ...itm,
        name,
        qty,
        quantity: qty,
        price,
        unitPrice: price,
        totalPrice: parseFloat((qty * price).toFixed(2))
      };
    });
  }

  // Relational and immutable fields that Prisma OrderUpdateInput rejects
  const ignoredKeys = [
    'id', 'db_id', 'tenantId', 'createdById', 'createdAt', 'updatedAt',
    'client', 'creator', 'tenant', 'deliveries', 'missions', 'invoices',
    'items', 'customItems', 'custom_items', 'manifestItems'
  ];
  ignoredKeys.forEach(k => delete orderData[k]);

  // Only valid scalar update fields for Prisma Order model
  const validDbKeys = [
    'orderNumber', 'status', 'priority', 'orderType', 'totalAmount'
  ];

  const dbData = {};
  const metadataExt = {};

  Object.keys(orderData).forEach(key => {
    if (key === 'clientId') return; // handled separately below
    if (validDbKeys.includes(key)) {
      dbData[key] = orderData[key];
    } else {
      metadataExt[key] = orderData[key];
    }
  });

  let metadataObj = typeof order.metadata === 'string' ? JSON.parse(order.metadata) : (order.metadata || {});

  // Identify original customer & client details so admin updates never detach the order from its customer
  const originalClientId = (metadataObj.client && metadataObj.client.id && metadataObj.client.id !== 153 && metadataObj.client.id !== 1)
    ? metadataObj.client.id
    : (order.clientId && order.clientId !== 153 && order.clientId !== 1 ? order.clientId : (metadataObj.clientId || null));

  const rawClientId = orderData.clientId || data.clientId;
  let parsedClientId = rawClientId && rawClientId !== 'CLT-GUEST' ? Number(rawClientId) : NaN;

  // If the parsedClientId is 153 or 1 (admin internal company) or missing, and this order has an original client, preserve originalClientId
  if (originalClientId && (!parsedClientId || isNaN(parsedClientId) || parsedClientId === 153 || parsedClientId === 1 || parsedClientId === tenantId)) {
    parsedClientId = Number(originalClientId);
  }

  if (!isNaN(parsedClientId) && parsedClientId > 0) {
    dbData.client = { connect: { id: parsedClientId } };
  }

  // Preserve customer and client identity fields in metadata
  const originalCustomerId = metadataObj.userId || metadataObj.user_id || metadataObj.customer_id || metadataObj.created_by || (metadataObj.customItems?.[0]?.userId) || (metadataObj.custom_items?.[0]?.user_id) || order.createdById;
  const originalCustomerEmail = metadataObj.customer_email || metadataObj.email || metadataObj.clientEmail || (metadataObj.client && metadataObj.client.email) || (metadataObj.customItems?.[0]?.email) || (metadataObj.custom_items?.[0]?.email) || null;
  const originalClientName = metadataObj.clientName || metadataObj.client_name || (metadataObj.client && metadataObj.client.companyName) || null;
  const originalClientObj = metadataObj.client || (order.client ? {
    id: order.client.id,
    companyName: order.client.companyName,
    clientCode: order.client.clientCode,
    contactPerson: order.client.contactPerson,
    email: order.client.email,
    plan: order.client.plan,
    clientType: order.client.clientType,
    status: order.client.status
  } : null);

  if (originalCustomerId) {
    metadataExt.userId = originalCustomerId;
    metadataExt.user_id = originalCustomerId;
    metadataExt.customer_id = originalCustomerId;
    metadataExt.created_by = originalCustomerId;
  }
  if (originalCustomerEmail) {
    metadataExt.email = originalCustomerEmail;
    metadataExt.customer_email = originalCustomerEmail;
    metadataExt.clientEmail = originalCustomerEmail;
  }
  if (parsedClientId) {
    metadataExt.clientId = parsedClientId;
    metadataExt.client_id = parsedClientId;
  }
  if (originalClientName) {
    metadataExt.clientName = originalClientName;
    metadataExt.client_name = originalClientName;
  }
  if (originalClientObj) {
    metadataExt.client = originalClientObj;
  }

  // Persist Vendor in metadata
  const incomingVendor = data.vendor || data.vendor_name || data.vendorName || metadataObj.vendor || metadataObj.vendor_name;
  const incomingVendorId = data.vendorId || data.vendor_id || metadataObj.vendorId || metadataObj.vendor_id;
  if (incomingVendor) {
    const vName = typeof incomingVendor === 'object' ? (incomingVendor.name || incomingVendor.companyName) : String(incomingVendor);
    metadataExt.vendor = vName;
    metadataExt.vendor_name = vName;
    metadataExt.vendorName = vName;
  }
  if (incomingVendorId && !isNaN(Number(incomingVendorId))) {
    metadataExt.vendorId = Number(incomingVendorId);
    metadataExt.vendor_id = Number(incomingVendorId);
  }

  // Calculate and assign total amount
  if (data.totalAmount !== undefined || data.total_amount !== undefined) {
    dbData.totalAmount = Number(data.totalAmount || data.total_amount || 0);
  } else if (formattedCustomItems.length > 0) {
    const computedTotal = formattedCustomItems.reduce((acc, it) => acc + (it.totalPrice || (it.quantity * it.unitPrice)), 0);
    if (computedTotal > 0) {
      dbData.totalAmount = parseFloat(computedTotal.toFixed(2));
    }
  }

  if (formattedCustomItems.length > 0) {
    metadataExt.customItems = formattedCustomItems;
    const c0 = formattedCustomItems[0];
    if (originalCustomerId) {
      c0.userId = originalCustomerId;
      c0.user_id = originalCustomerId;
      c0.customer_id = originalCustomerId;
    }
    if (originalCustomerEmail) {
      c0.email = originalCustomerEmail;
      c0.customer_email = originalCustomerEmail;
    }
    if (parsedClientId) {
      c0.clientId = parsedClientId;
    }
    if (originalClientName) {
      c0.clientName = originalClientName;
    }

    // Synchronize Prisma orderItem records with updated line items
    try {
      const existingOrderItems = await prisma.orderItem.findMany({
        where: { orderId: order.id },
        include: { deliveryItems: true }
      });

      for (let i = 0; i < formattedCustomItems.length; i++) {
        const itemSpec = formattedCustomItems[i];
        let resolvedItemId = itemSpec.itemId && !isNaN(Number(itemSpec.itemId)) ? Number(itemSpec.itemId) : null;
        if (!resolvedItemId && itemSpec.name) {
          const foundItem = await prisma.item.findFirst({
            where: {
              OR: [
                { name: { equals: String(itemSpec.name).trim() } },
                { name: { contains: String(itemSpec.name).trim() } }
              ]
            }
          });
          if (foundItem) resolvedItemId = foundItem.id;
        }

        if (existingOrderItems[i]) {
          await prisma.orderItem.update({
            where: { id: existingOrderItems[i].id },
            data: {
              quantity: Number(itemSpec.quantity),
              unitPrice: Number(itemSpec.unitPrice),
              totalPrice: Number(itemSpec.totalPrice),
              ...(resolvedItemId ? { itemId: resolvedItemId } : {})
            }
          });
        } else if (resolvedItemId) {
          await prisma.orderItem.create({
            data: {
              tenantId: order.tenantId || 1,
              orderId: order.id,
              itemId: resolvedItemId,
              warehouseId: itemSpec.warehouseId ? Number(itemSpec.warehouseId) : (existingOrderItems[0]?.warehouseId || 1),
              quantity: Number(itemSpec.quantity),
              unitPrice: Number(itemSpec.unitPrice),
              totalPrice: Number(itemSpec.totalPrice)
            }
          });
        }
      }

      // If existing records exceed updated items and have no dependent deliveryItems, delete excess
      if (existingOrderItems.length > formattedCustomItems.length) {
        for (let j = formattedCustomItems.length; j < existingOrderItems.length; j++) {
          const excess = existingOrderItems[j];
          if (!excess.deliveryItems || excess.deliveryItems.length === 0) {
            await prisma.orderItem.delete({ where: { id: excess.id } }).catch(() => {});
          }
        }
      }
    } catch (orderItemSyncErr) {
      console.warn('[OrderItem Sync Warning]', orderItemSyncErr);
    }

    if (c0.passengerName) metadataExt.passengerName = c0.passengerName;
    if (c0.guestName) metadataExt.guestName = c0.guestName;
    if (c0.numberOfPassengers) {
      metadataExt.numberOfPassengers = Number(c0.numberOfPassengers);
      metadataExt.passengers = Number(c0.numberOfPassengers);
      metadataExt.passengerCount = Number(c0.numberOfPassengers);
    }
    if (c0.wifi) metadataExt.wifi = c0.wifi;
    if (c0.refreshments) metadataExt.refreshments = c0.refreshments;
    if (c0.carSeat) metadataExt.carSeat = c0.carSeat;
    if (c0.stops) metadataExt.stops = c0.stops;
    if (c0.stopLocations) metadataExt.stopLocations = c0.stopLocations;
    if (c0.luggage) metadataExt.luggage = c0.luggage;
    if (c0.bags !== undefined) metadataExt.bags = c0.bags;
    if (c0.serviceType) metadataExt.serviceType = c0.serviceType;
    if (c0.returnDate) metadataExt.returnDate = c0.returnDate;
    if (c0.returnTime) metadataExt.returnTime = c0.returnTime;
    if (c0.pickupTime) metadataExt.pickupTime = c0.pickupTime;
    if (c0.pickupLocation) metadataExt.pickupLocation = c0.pickupLocation;
    if (c0.dropLocation || c0.location) {
      metadataExt.dropLocation = c0.dropLocation || c0.location;
      metadataExt.location = c0.dropLocation || c0.location;
    }
    if (c0.amenities) metadataExt.amenities = c0.amenities;
  }

  // --- Resolve Driver and Vehicle Assignment ---
  const incomingMeta = typeof data.metadata === 'object' && data.metadata ? data.metadata : {};
  let driverUserId = data.driver_user_id || data.driverId || metadataExt.driver_user_id || metadataExt.driverId || incomingMeta.driver_user_id || incomingMeta.driverId || metadataObj.driver_user_id || metadataObj.driverId;
  let driverName = data.driverName || metadataExt.driverName || incomingMeta.driverName || metadataObj.driverName;
  let plateNumber = data.plateNumber || data.vehicleId || data.vehicle || metadataExt.plateNumber || metadataExt.vehicleId || metadataExt.vehicle || incomingMeta.plateNumber || incomingMeta.vehicleId || incomingMeta.vehicle || metadataObj.plateNumber || metadataObj.vehicleId;

  let employee = null;
  if (driverUserId && !isNaN(Number(driverUserId))) {
    employee = await prisma.employee.findFirst({
      where: {
        OR: [
          { userId: Number(driverUserId) },
          { id: Number(driverUserId) }
        ]
      },
      include: { user: true }
    });
  } else if (driverName && typeof driverName === 'string') {
    const nameParts = driverName.trim().split(' ');
    employee = await prisma.employee.findFirst({
      where: {
        OR: [
          { firstName: { contains: nameParts[0] } },
          { user: { name: { contains: driverName.trim() } } }
        ]
      },
      include: { user: true }
    });
  }

  if (employee) {
    driverName = `${employee.firstName || ''} ${employee.lastName || ''}`.trim() || employee.user?.name || driverName;
    driverUserId = employee.user?.id || employee.userId;
    metadataExt.driverName = driverName;
    metadataExt.driver_user_id = driverUserId;
    metadataExt.driverId = driverUserId;
    if (employee.user?.avatar) {
      metadataExt.driverPhotoUrl = employee.user.avatar;
    }
  } else if (driverName) {
    metadataExt.driverName = driverName;
    if (driverUserId) {
      metadataExt.driver_user_id = Number(driverUserId);
      metadataExt.driverId = Number(driverUserId);
    }
  }

  if (plateNumber) {
    metadataExt.plateNumber = String(plateNumber).trim();
    metadataExt.vehicleId = String(plateNumber).trim();
    metadataExt.vehicle = String(plateNumber).trim();
  }

  if (customItems.length > 0 || (metadataExt.customItems && metadataExt.customItems.length > 0)) {
    const targetCustomItems = metadataExt.customItems || customItems;
    if (targetCustomItems[0]) {
      if (plateNumber) {
        targetCustomItems[0].plateNumber = String(plateNumber).trim();
        targetCustomItems[0].vehicleId = String(plateNumber).trim();
        targetCustomItems[0].vehicle = String(plateNumber).trim();
      }
      if (driverName) {
        targetCustomItems[0].driverName = driverName;
      }
      if (driverUserId) {
        targetCustomItems[0].driver_user_id = driverUserId;
        targetCustomItems[0].driverId = driverUserId;
      }
    }
  }

  if (driverName || driverUserId) {
    metadataExt.adminApproved = true;
  }

  let newStatus = data.status ? String(data.status).toLowerCase() : order.status;
  // If driver or vehicle is newly assigned and status is pending, advance status to assigned
  if ((driverName || driverUserId || plateNumber) && ['pending', 'pending_review', 'created', 'draft'].includes(newStatus)) {
    newStatus = 'assigned';
  }
  metadataExt.chauffeur_status = newStatus;
  metadataExt.status = newStatus;

  const finalMetadata = {
    ...metadataObj,
    ...metadataExt
  };

  const updatedOrder = await prisma.order.update({
    where: { id: order.id },
    data: {
      ...dbData,
      status: newStatus,
      metadata: finalMetadata
    }
  });

  // Cross-table synchronization: Sync Driver & Vehicle to Delivery
  const isChauffeurOrDelivery = ['CHAUFFEUR', 'PRODUCT', 'DELIVERY', 'CONCIERGE'].includes(String(updatedOrder.orderType || '').toUpperCase());
  if (isChauffeurOrDelivery && (driverName || driverUserId || plateNumber || employee)) {
    try {
      const existingDelivery = await prisma.delivery.findFirst({
        where: { orderId: order.id }
      });

      const delStatus = ['completed', 'delivered'].includes(newStatus)
        ? 'delivered'
        : (newStatus === 'en_route' ? 'en_route' : (['in_transit', 'en_route'].includes(newStatus) ? 'in_transit' : 'assigned'));

      if (existingDelivery) {
        let existingRemarks = {};
        if (existingDelivery.remarks) {
          try { existingRemarks = JSON.parse(existingDelivery.remarks); } catch (_) {}
        }
        if (formattedCustomItems.length > 0) {
          existingRemarks.manifestItems = formattedCustomItems;
        }
        await prisma.delivery.update({
          where: { id: existingDelivery.id },
          data: {
            ...(employee ? { assignedTo: employee.id } : {}),
            ...(plateNumber ? { vehicleRef: String(plateNumber).trim() } : {}),
            remarks: JSON.stringify(existingRemarks),
            status: delStatus
          }
        });
      } else {
        const deliveryCount = await prisma.delivery.count({ where: { tenantId: updatedOrder.tenantId } });
        const deliveryNumber = `DEL-${new Date().getFullYear()}-${String(deliveryCount + 1).padStart(4, '0')}`;

        let warehouse = await prisma.warehouse.findFirst({ where: { tenantId: updatedOrder.tenantId } });
        if (!warehouse) warehouse = await prisma.warehouse.findFirst();

        await prisma.delivery.create({
          data: {
            tenantId: updatedOrder.tenantId,
            deliveryNumber,
            orderId: order.id,
            clientId: updatedOrder.clientId,
            assignedTo: employee ? employee.id : null,
            warehouseId: warehouse ? warehouse.id : 1,
            status: delStatus,
            missionType: updatedOrder.orderType === 'CHAUFFEUR' ? 'Chauffeur' : 'Delivery',
            transportMode: 'Road',
            vehicleRef: plateNumber ? String(plateNumber).trim() : null,
            pickupLocation: finalMetadata.pickupLocation || finalMetadata.pickup_location || null,
            dropLocation: finalMetadata.dropLocation || finalMetadata.drop_location || finalMetadata.location || null,
            remarks: JSON.stringify({
              driver: driverName,
              assigned_driver: employee ? employee.id : driverUserId,
              driverId: driverUserId,
              vehicle: plateNumber,
              passengerInfo: {
                name: finalMetadata.passengerName || finalMetadata.guestName || finalMetadata.clientName || '',
                count: finalMetadata.numberOfPassengers || finalMetadata.passengers || 1
              }
            })
          }
        });
      }
    } catch (delErr) {
      console.error('[Order -> Delivery Sync Error]', delErr);
    }

    // Cross-table synchronization: Sync to Mission
    if (employee) {
      try {
        const existingMission = await prisma.mission.findFirst({
          where: { orderId: id }
        });
        if (existingMission) {
          await prisma.mission.update({
            where: { id: existingMission.id },
            data: {
              assignedEmployeeId: employee.id,
              status: ['completed', 'delivered'].includes(newStatus) ? 'completed' : 'assigned',
              metadata: {
                ...(typeof existingMission.metadata === 'object' ? existingMission.metadata : {}),
                driverName,
                driverId: driverUserId,
                plateNumber,
                vehicleId: plateNumber
              }
            }
          });
        }
      } catch (misErr) {
        console.error('[Order -> Mission Sync Error]', misErr);
      }
    }
  }

  if (['cancelled', 'rejected', 'canceled'].includes(newStatus)) {
    await prisma.delivery.updateMany({
      where: { orderId: id },
      data: { status: 'cancelled' }
    }).catch(() => null);
    await prisma.mission.updateMany({
      where: { orderId: id },
      data: { status: 'cancelled' }
    }).catch(() => null);
  }

  const { metadata, ...rest } = updatedOrder;
  return {
    ...rest,
    metadata: finalMetadata,
    driverName: finalMetadata.driverName || null,
    driver_user_id: finalMetadata.driver_user_id || finalMetadata.driverId || null,
    driverId: finalMetadata.driverId || finalMetadata.driver_user_id || null,
    plateNumber: finalMetadata.plateNumber || null,
    vehicleId: finalMetadata.vehicleId || finalMetadata.plateNumber || null,
    vehicle: finalMetadata.vehicle || finalMetadata.plateNumber || null,
    vehicleRef: finalMetadata.plateNumber || null,
    ...finalMetadata
  };
};

export const convertOrderToProject = async (orderId, projectData, tenantId, performerId) => {
  const order = await getOrderById(orderId, tenantId);

  // Generate unique order number
  const count = await prisma.order.count({ where: { tenantId: order.tenantId } });
  const orderNumber = `PRJ-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;

  const employee = await prisma.employee.findUnique({ where: { userId: performerId } });
  const createdById = employee ? employee.id : 1;

  // Extract client name
  const client = await clientRepo.findClientById(order.clientId);
  const clientName = client ? client.companyName : 'N/A';

  const metadata = {
    name: projectData.name || `Project for Order #${order.orderNumber}`,
    description: projectData.description || order.notes || '',
    startDate: projectData.startDate || projectData.start || new Date().toISOString().split('T')[0],
    location: projectData.location || order.location || '',
    delivery_type: projectData.delivery_type || projectData.deliveryType || 'Road',
    client_name: clientName,
    orderRef: order.id,
    order_ref: order.id,
    order_id: order.id
  };

  const project = await prisma.order.create({
    data: {
      tenantId: order.tenantId,
      orderNumber,
      clientId: order.clientId,
      createdById,
      status: projectData.status || 'planned',
      orderType: 'Project',
      totalAmount: order.totalAmount || 0,
      metadata
    }
  });

  // Update original order's status to logistics
  try {
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'logistics' }
    });
  } catch (_) {}

  await logAudit({
    module: 'ORDERS',
    action: 'CREATE',
    description: `Converted Order ${order.orderNumber} to Project ${project.orderNumber}`,
    newValue: project,
    performedBy: performerId
  });

  return {
    id: project.id,
    name: metadata.name,
    client: metadata.client_name,
    clientId: project.clientId,
    start: metadata.startDate,
    location: metadata.location,
    status: project.status,
    deliveryType: metadata.delivery_type,
    companyId: order.companyId || null,
    customerId: order.clientId || null,
    clientUserId: null
  };
};

export const deleteOrder = async (orderId, tenantIdToFilter, clientIdToFilter, performerId) => {
  return await prisma.$transaction(async (tx) => {
    let where = { id: orderId };
    if (tenantIdToFilter !== null) where.tenantId = tenantIdToFilter;
    if (clientIdToFilter !== null) where.clientId = clientIdToFilter;

    let order = await tx.order.findFirst({
      where,
      include: { items: true }
    });

    if (!order && tenantIdToFilter !== null) {
      const fallbackWhere = { id: orderId };
      if (clientIdToFilter !== null) fallbackWhere.clientId = clientIdToFilter;
      order = await tx.order.findFirst({
        where: fallbackWhere,
        include: { items: true }
      });
    }

    if (!order) {
      throw new AppError('Order not found or access denied', 404);
    }

    // Release reserved stock for inventory items if status is not delivered/cancelled
    if (order.status !== 'delivered' && order.status !== 'cancelled' && order.orderType === 'DELIVERY') {
      await releaseReservedStock(tx, order.items);
    }

    // Cascade delete Invoices & related
    const invoices = await tx.invoice.findMany({ where: { orderId: order.id }, select: { id: true } });
    const invoiceIds = invoices.map(i => i.id);
    if (invoiceIds.length > 0) {
      await tx.receipt.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await tx.payment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await tx.invoice.deleteMany({ where: { orderId: order.id } });
    }

    // Cascade delete Deliveries & related
    const deliveries = await tx.delivery.findMany({ where: { orderId: order.id }, select: { id: true } });
    const deliveryIds = deliveries.map(d => d.id);
    if (deliveryIds.length > 0) {
      await tx.deliveryItem.deleteMany({ where: { deliveryId: { in: deliveryIds } } });
      await tx.delivery.deleteMany({ where: { orderId: order.id } });
    }

    // Cascade delete Missions
    await tx.mission.deleteMany({ where: { orderId: order.id } });

    // Delete associated order items
    if (order.items && order.items.length > 0) {
      await tx.orderItem.deleteMany({ where: { orderId: order.id } });
    }

    // Delete the order itself
    await tx.order.delete({ where: { id: order.id } });

    await logAudit({
      module: 'ORDERS',
      action: 'DELETE',
      description: `Deleted Order ${order.orderNumber}`,
      newValue: null,
      performedBy: performerId
    });

    return true;
  }, { maxWait: 15000, timeout: 30000 });
};


