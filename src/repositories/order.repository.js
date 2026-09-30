import prisma from '../config/db.js';

const generateOrderNumber = async (tenantId) => {
  const lastOrder = await prisma.order.findFirst({
    orderBy: { id: 'desc' }
  });
  const nextNum = lastOrder ? lastOrder.id + 1 : 1;
  return `ORD-${new Date().getFullYear()}-${String(nextNum).padStart(4, '0')}`;
};

export const createOrder = async (data, items, tenantId, tx = null) => {
  const clientToUse = tx || prisma;
  const resolvedTenantId = (tenantId != null && !isNaN(Number(tenantId))) ? Number(tenantId) : (data.tenantId != null ? Number(data.tenantId) : 1);
  const orderNumber = data.orderNumber || await generateOrderNumber(resolvedTenantId);
  
  const itemsArray = items || [];
  let computedTotalAmount = itemsArray.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0);
  
  // If no explicit DB items but we have a total amount in data, use it
  if (computedTotalAmount === 0 && (data.totalAmount !== undefined || data.total_amount !== undefined)) {
      computedTotalAmount = Number(data.totalAmount || data.total_amount || 0);
  }

  const validDbKeys = [
    'id',
    'tenantId',
    'orderNumber',
    'clientId',
    'createdById',
    'status',
    'priority',
    'orderType',
    'metadata',
    'totalAmount',
    'createdAt',
    'updatedAt'
  ];

  const dbData = {};
  const metadataExt = {};

  Object.keys(data).forEach(key => {
    if (validDbKeys.includes(key)) {
      dbData[key] = data[key];
    } else {
      metadataExt[key] = data[key];
    }
  });

  const existingMetadata = typeof data.metadata === 'string'
    ? JSON.parse(data.metadata)
    : (data.metadata || {});

  const finalMetadata = {
    ...existingMetadata,
    ...metadataExt
  };

  const dbOrderItems = itemsArray.filter(item => item && item.itemId && !isNaN(Number(item.itemId)) && Number(item.itemId) > 0).map(item => ({
    itemId: Number(item.itemId),
    warehouseId: Number(item.warehouseId || 1),
    quantity: Number(item.quantity || 1),
    unitPrice: Number(item.unitPrice || 0),
    totalPrice: Number(item.totalPrice != null ? item.totalPrice : ((item.quantity || 1) * (item.unitPrice || 0))),
    tenantId: resolvedTenantId
  }));

  const newOrder = await clientToUse.order.create({
    data: {
      ...dbData,
      orderNumber,
      tenantId: resolvedTenantId,
      totalAmount: computedTotalAmount,
      metadata: finalMetadata,
      ...(dbOrderItems.length > 0 && {
        items: {
          create: dbOrderItems
        }
      })
    },
    include: { items: true, client: true }
  });

  const { metadata, ...rest } = newOrder;
  return {
    ...finalMetadata,
    ...rest,
    metadata: finalMetadata
  };
};

export const findOrderById = async (id) => {
  let numId = Number(id);
  let order = null;
  if (!isNaN(numId) && numId > 0) {
    order = await prisma.order.findUnique({
      where: { id: numId },
      include: {
        items: { include: { item: true } },
        client: true,
        creator: { select: { firstName: true, lastName: true } },
        deliveries: {
          include: {
            assignee: { select: { firstName: true, lastName: true, userId: true } }
          }
        }
      }
    });
  }

  if (!order && typeof id === 'string' && id.trim()) {
    order = await prisma.order.findFirst({
      where: { orderNumber: id.trim() },
      include: {
        items: { include: { item: true } },
        client: true,
        creator: { select: { firstName: true, lastName: true } },
        deliveries: {
          include: {
            assignee: { select: { firstName: true, lastName: true, userId: true } }
          }
        }
      }
    });
  }

  if (!order) return null;
  const { metadata, ...rest } = order;
  const metadataObj = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata || {});

  const linkedDel = order.deliveries && order.deliveries.find(d => d.assignedTo || d.vehicleRef);
  const c0 = (Array.isArray(metadataObj.customItems) && metadataObj.customItems[0]) || (Array.isArray(metadataObj.custom_items) && metadataObj.custom_items[0]) || {};

  let resolvedDriverName = metadataObj.driverName || c0.driverName;
  let resolvedDriverUserId = metadataObj.driver_user_id || metadataObj.driverId || c0.driver_user_id || c0.driverId;
  let resolvedPlateNumber = metadataObj.plateNumber || metadataObj.vehicleId || metadataObj.vehicle || c0.plateNumber || c0.vehicleId || c0.vehicle;

  if (!resolvedDriverName && linkedDel?.assignee) {
    resolvedDriverName = `${linkedDel.assignee.firstName || ''} ${linkedDel.assignee.lastName || ''}`.trim();
    resolvedDriverUserId = linkedDel.assignee.userId;
  }
  if (!resolvedPlateNumber && linkedDel?.vehicleRef) {
    resolvedPlateNumber = linkedDel.vehicleRef;
  }

  const enrichedMeta = {
    ...metadataObj,
    ...(resolvedDriverName ? { driverName: resolvedDriverName } : {}),
    ...(resolvedDriverUserId ? { driver_user_id: resolvedDriverUserId, driverId: resolvedDriverUserId } : {}),
    ...(resolvedPlateNumber ? { plateNumber: resolvedPlateNumber, vehicleId: resolvedPlateNumber, vehicle: resolvedPlateNumber } : {})
  };

  const dbItems = Array.isArray(rest.items) ? rest.items.map(it => ({
    ...it,
    name: it.item?.name || it.name || 'Asset',
    qty: it.quantity != null ? it.quantity : (it.qty != null ? it.qty : 1),
    quantity: it.quantity != null ? it.quantity : (it.qty != null ? it.qty : 1),
    price: it.unitPrice != null ? it.unitPrice : (it.price != null ? it.price : 0),
    unitPrice: it.unitPrice != null ? it.unitPrice : (it.price != null ? it.price : 0),
    totalPrice: it.totalPrice != null ? it.totalPrice : ((it.quantity || 1) * (it.unitPrice || 0))
  })) : [];

  const metaCustom = Array.isArray(metadataObj.customItems) ? metadataObj.customItems : (Array.isArray(metadataObj.custom_items) ? metadataObj.custom_items : []);
  const metaItems = metaCustom.map((it, idx) => ({
    ...it,
    name: it.name || it.itemName || it.item?.name || `Item ${idx + 1}`,
    qty: it.qty != null ? it.qty : (it.quantity != null ? it.quantity : 1),
    quantity: it.quantity != null ? it.quantity : (it.qty != null ? it.qty : 1),
    price: it.price != null ? it.price : (it.unitPrice != null ? it.unitPrice : 0),
    unitPrice: it.unitPrice != null ? it.unitPrice : (it.price != null ? it.price : 0),
    totalPrice: it.totalPrice != null ? it.totalPrice : ((it.quantity || it.qty || 1) * (it.price || it.unitPrice || 0))
  }));

  const finalItems = dbItems.length > 0 ? dbItems : metaItems;

  return {
    ...enrichedMeta,
    ...rest,
    items: finalItems,
    customItems: finalItems,
    vendor: enrichedMeta.vendor || enrichedMeta.vendor_name || rest.vendor || null,
    vendorId: enrichedMeta.vendorId || enrichedMeta.vendor_id || rest.vendorId || null,
    driverName: resolvedDriverName || null,
    driver_user_id: resolvedDriverUserId || null,
    driverId: resolvedDriverUserId || null,
    plateNumber: resolvedPlateNumber || null,
    vehicleId: resolvedPlateNumber || null,
    vehicle: resolvedPlateNumber || null,
    vehicleRef: resolvedPlateNumber || null,
    metadata: enrichedMeta
  };
};

export const findAllOrders = async (tenantId, query) => {
  const { page = 1, limit = 10, search = '', status, clientId, user_id, customer_email, customer_name, orderType, currentDept, passedThrough } = query;
  const skip = (page - 1) * limit;

  const isCustomerFilter = !!(user_id || customer_email || customer_name);
  const where = {
    ...(!isCustomerFilter && tenantId !== null && tenantId !== undefined && { tenantId }),
    ...(search && { orderNumber: { contains: search } }),
    ...(status && { status }),
    ...(!isCustomerFilter && clientId && { clientId: Number(clientId) }),
    ...(orderType && {
      OR: [
        { orderType: orderType },
        { orderType: String(orderType).toLowerCase() },
        { orderType: String(orderType).toUpperCase() }
      ]
    })
  };

  // currentDept: orders currently in this department (metadata.currentDepartment)
  // passedThrough: orders that previously passed through this department (in workflowHistory)
  // These are applied post-query since they depend on JSON fields
  let applyCurrentDeptFilter = currentDept ? String(currentDept).toLowerCase() : null;
  let applyPassedThroughFilter = passedThrough ? String(passedThrough).toLowerCase() : null;

  // Fetch all matching orders first (we post-filter JSON metadata fields)
  const allOrders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      items: { include: { item: true } },
      client: { select: { id: true, companyName: true, clientCode: true, contactPerson: true, email: true, plan: true, clientType: true, status: true } },
      deliveries: {
        include: {
          assignee: { select: { firstName: true, lastName: true, userId: true } }
        }
      }
    }
  });

  let mappedOrders = allOrders.map(o => {
    const { metadata, ...rest } = o;
    const metadataObj = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata || {});
    const manifestCandidates = metadataObj.customItems || metadataObj.custom_items || metadataObj.manifestItems || metadataObj.items || metadataObj.cart || [];
    const metaList = Array.isArray(manifestCandidates) ? manifestCandidates : [];

    let itemsArr = (o.items && o.items.length > 0)
      ? o.items.map((oi, idx) => {
          const metaMatch = metaList[idx] || metaList.find(m => (m.itemId && m.itemId === oi.itemId) || (m.id && m.id === oi.itemId) || m.name === oi.item?.name);
          return {
            ...oi,
            name: metaMatch?.name || oi.name || oi.item?.name || `Item ${idx + 1}`,
            price: oi.unitPrice != null ? oi.unitPrice : (metaMatch?.price || oi.item?.price || 0)
          };
        })
      : metaList;

    const linkedDel = o.deliveries && o.deliveries.find(d => d.assignedTo || d.vehicleRef);
    const c0 = (Array.isArray(metadataObj.customItems) && metadataObj.customItems[0]) || (Array.isArray(metadataObj.custom_items) && metadataObj.custom_items[0]) || {};

    let resolvedDriverName = metadataObj.driverName || c0.driverName;
    let resolvedDriverUserId = metadataObj.driver_user_id || metadataObj.driverId || c0.driver_user_id || c0.driverId;
    let resolvedPlateNumber = metadataObj.plateNumber || metadataObj.vehicleId || metadataObj.vehicle || c0.plateNumber || c0.vehicleId || c0.vehicle;

    if (!resolvedDriverName && linkedDel?.assignee) {
      resolvedDriverName = `${linkedDel.assignee.firstName || ''} ${linkedDel.assignee.lastName || ''}`.trim();
      resolvedDriverUserId = linkedDel.assignee.userId;
    }
    if (!resolvedPlateNumber && linkedDel?.vehicleRef) {
      resolvedPlateNumber = linkedDel.vehicleRef;
    }

    const enrichedMeta = {
      ...metadataObj,
      ...(resolvedDriverName ? { driverName: resolvedDriverName } : {}),
      ...(resolvedDriverUserId ? { driver_user_id: resolvedDriverUserId, driverId: resolvedDriverUserId } : {}),
      ...(resolvedPlateNumber ? { plateNumber: resolvedPlateNumber, vehicleId: resolvedPlateNumber, vehicle: resolvedPlateNumber } : {})
    };

    // Restore effective client if order.client is missing or pointing to internal HQ (153 or 1) while metadata has the real client
    const effectiveClient = (o.client && o.client.id !== 153 && o.client.id !== 1)
      ? o.client
      : (metadataObj.client || o.client);
    const effectiveClientId = effectiveClient ? effectiveClient.id : (o.clientId || metadataObj.clientId || metadataObj.client?.id);

    return {
      ...enrichedMeta,
      ...rest,
      client: effectiveClient,
      clientId: effectiveClientId,
      items: itemsArr,
      customItems: metaList.length > 0 ? metaList : itemsArr,
      vendor: enrichedMeta.vendor || enrichedMeta.vendor_name || rest.vendor || null,
      vendorId: enrichedMeta.vendorId || enrichedMeta.vendor_id || rest.vendorId || null,
      driverName: resolvedDriverName || null,
      driver_user_id: resolvedDriverUserId || null,
      driverId: resolvedDriverUserId || null,
      plateNumber: resolvedPlateNumber || null,
      vehicleId: resolvedPlateNumber || null,
      vehicle: resolvedPlateNumber || null,
      vehicleRef: resolvedPlateNumber || null,
      metadata: enrichedMeta
    };
  });

  // For Concierge role queries, enforce Concierge Order Visibility Rule:
  // - Concierge Requests/Orders: ALWAYS visible
  // - Marketplace Orders: Visible ONLY for clients with upgraded accounts in database
  const isConciergeViewer = query.viewerRole === 'concierge' || query.role === 'concierge';
  if (isConciergeViewer) {
    mappedOrders = mappedOrders.filter(o => {
      const typeStr = String(o.orderType || o.type || '').toUpperCase();
      const kindStr = String(o.orderKind || o.kind || '').toLowerCase();
      const statusStr = String(o.status || '').toLowerCase();
      const meta = o.metadata || {};

      const isConciergeReq =
        typeStr.includes('CONCIERGE') || typeStr.includes('CHAUFFEUR') || typeStr.includes('EVENTS') || typeStr.includes('BESPOKE') || typeStr.includes('VIP') ||
        kindStr.includes('custom') || kindStr.includes('bespoke') || kindStr.includes('concierge') || kindStr.includes('chauffeur') ||
        statusStr === 'concierge' || meta.custom_request_category || o.isConcierge || o.isCustomRequest;

      if (isConciergeReq) return true;

      // For marketplace orders, check if client account is upgraded in database
      const client = o.client;
      if (!client) return false;
      const planStr = String(client.plan || '').toLowerCase();
      const typeStrClient = String(client.clientType || '').toLowerCase();
      const upgradedKeywords = ['upgraded', 'vip', 'saas', 'enterprise', 'corporate', 'pro', 'concierge', 'lifestyle', 'membership', 'premium', 'business'];

      return upgradedKeywords.some(kw => planStr.includes(kw) || typeStrClient.includes(kw));
    });
  }

  // For customer queries, ensure orders matching customer's user_id, email, clientId, or name are included
  if (isCustomerFilter) {
    const filterClientId = clientId ? String(clientId).trim() : null;
    const filterUserId = user_id ? String(user_id).trim() : null;
    const filterEmail = customer_email ? String(customer_email).toLowerCase().trim() : null;
    const filterName = customer_name ? String(customer_name).toLowerCase().trim() : null;

    mappedOrders = mappedOrders.filter(o => {
      const c0 = o.metadata?.customItems?.[0] || o.metadata?.custom_items?.[0] || {};

      const userIds = [
        String(o.createdById || ''),
        String(o.userId || ''),
        String(o.user_id || ''),
        String(o.customer_id || ''),
        String(o.metadata?.userId || ''),
        String(o.metadata?.user_id || ''),
        String(o.metadata?.customer_id || ''),
        String(o.metadata?.created_by || ''),
        String(c0.userId || ''),
        String(c0.user_id || ''),
        String(c0.customer_id || ''),
      ].filter(Boolean);

      const clientIds = [
        String(o.clientId || ''),
        String(o.client_id || ''),
        String(o.client?.id || ''),
        String(o.metadata?.clientId || ''),
        String(o.metadata?.client_id || ''),
        String(o.metadata?.client?.id || ''),
        String(c0.clientId || ''),
      ].filter(Boolean);

      const emails = [
        String(o.client?.email || ''),
        String(o.email || ''),
        String(o.client_email || ''),
        String(o.customer_email || ''),
        String(o.metadata?.email || ''),
        String(o.metadata?.user_email || ''),
        String(o.metadata?.customer_email || ''),
        String(o.metadata?.client_email || ''),
        String(o.metadata?.client?.email || ''),
        String(c0.email || ''),
        String(c0.customer_email || ''),
      ].filter(Boolean).map(e => e.toLowerCase().trim());

      const names = [
        String(o.client?.companyName || ''),
        String(o.client?.name || ''),
        String(o.metadata?.clientName || ''),
        String(o.metadata?.client_name || ''),
        String(o.metadata?.guestName || ''),
        String(o.metadata?.passengerName || ''),
        String(o.metadata?.customer_name || ''),
        String(c0.clientName || ''),
        String(c0.passengerName || ''),
        String(c0.guestName || ''),
      ].filter(Boolean).map(n => n.toLowerCase().trim());

      if (filterUserId && userIds.includes(filterUserId)) return true;
      if (filterClientId && clientIds.includes(filterClientId)) return true;
      if (filterEmail && emails.some(e => e === filterEmail || e.includes(filterEmail) || filterEmail.includes(e))) return true;
      if (filterName && names.some(n => n === filterName || n.includes(filterName) || filterName.includes(n))) return true;

      return false;
    });
  }

  // Post-filter by department (JSON metadata fields + status aliases)
  if (applyCurrentDeptFilter) {
    mappedOrders = mappedOrders.filter(o => {
      const metaDept = String(o.metadata?.currentDepartment || o.metadata?.routed_department || o.metadata?.route_department || '').toLowerCase();
      if (metaDept && metaDept === applyCurrentDeptFilter) return true;

      const rawStatus = String(o.status || '').toLowerCase();
      if (applyCurrentDeptFilter === 'admin' && ['admin', 'admin_review', 'pending_review', 'draft'].includes(rawStatus)) return true;
      if (applyCurrentDeptFilter === 'operations' && ['operations', 'submitted', 'review', 'approved', 'ready_for_delivery'].includes(rawStatus)) return true;
      if (applyCurrentDeptFilter === 'procurement' && ['procurement', 'purchase_requested'].includes(rawStatus)) return true;
      if (applyCurrentDeptFilter === 'inventory' && ['inventory', 'stock_reserved'].includes(rawStatus)) return true;
      if (applyCurrentDeptFilter === 'logistics' && ['logistics', 'dispatched', 'in_transit', 'en_route'].includes(rawStatus)) return true;
      if (applyCurrentDeptFilter === 'concierge' && ['concierge'].includes(rawStatus)) return true;

      return rawStatus === applyCurrentDeptFilter;
    });
  }
  if (applyPassedThroughFilter) {
    mappedOrders = mappedOrders.filter(o => {
      const history = Array.isArray(o.metadata?.workflowHistory) ? o.metadata.workflowHistory : [];
      if (history.some(h => String(h.department || '').toLowerCase() === applyPassedThroughFilter)) return true;
      if (applyPassedThroughFilter === 'logistics') {
        const rawStatus = String(o.status || '').toLowerCase();
        if (['logistics', 'dispatched', 'in_transit', 'en_route', 'delivered', 'completed'].includes(rawStatus) || (o.deliveries && o.deliveries.length > 0)) {
          return true;
        }
      }
      return false;
    });
  }

  // Paginate after filtering
  const total = mappedOrders.length;
  const paginated = mappedOrders.slice((Number(page) - 1) * Number(limit), (Number(page) - 1) * Number(limit) + Number(limit));

  return { orders: paginated, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) };
};

export const updateOrderStatus = async (id, status, newMetadata) => {
  const updatedOrder = await prisma.order.update({
    where: { id },
    data: {
      status,
      ...(newMetadata !== undefined && { metadata: newMetadata })
    }
  });
  if (!updatedOrder) return null;
  const { metadata, ...rest } = updatedOrder;
  const metadataObj = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata || {});
  return {
    ...rest,
    metadata: metadataObj,
    ...metadataObj
  };
};

export const deleteOrder = async (id) => {
  return await prisma.order.delete({ where: { id } });
};
