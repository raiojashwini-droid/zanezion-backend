import prisma from '../config/db.js';

const SENSITIVE_KEYS_REDACT = ['password', 'resettoken', 'token', 'refreshtoken', 'routing_number', 'routing'];

export const sanitizeAuditData = (data) => {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(sanitizeAuditData);

  const clean = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();

    if (SENSITIVE_KEYS_REDACT.includes(lowerKey)) {
      clean[key] = '[REDACTED]';
    } else if (lowerKey === 'nibnumber' || lowerKey === 'nib_number') {
      const strVal = String(value || '');
      clean[key] = strVal.length > 3 ? `****${strVal.slice(-3)}` : '****';
    } else if (lowerKey === 'account' || lowerKey === 'account_number') {
      const strVal = String(value || '');
      clean[key] = strVal.length > 4 ? `****${strVal.slice(-4)}` : '****';
    } else if ((lowerKey === 'bankinginfo' || lowerKey === 'banking_info') && typeof value === 'object' && value !== null) {
      clean[key] = sanitizeAuditData(value);
    } else if (typeof value === 'object' && value !== null) {
      clean[key] = sanitizeAuditData(value);
    } else {
      clean[key] = value;
    }
  }
  return clean;
};

export const logAudit = ({
  module,
  action,
  description = null,
  oldValue = null,
  newValue = null,
  performedBy
}) => {
  // Fire-and-forget asynchronously - zero overhead on API responses
  if (!performedBy) return Promise.resolve();

  return new Promise((resolve) => {
    setImmediate(async () => {
      try {
        const perfId = Number(performedBy);
        if (isNaN(perfId) || perfId <= 0) return resolve();

        const safeOldValue = oldValue ? sanitizeAuditData(JSON.parse(JSON.stringify(oldValue))) : null;
        const safeNewValue = newValue ? sanitizeAuditData(JSON.parse(JSON.stringify(newValue))) : null;

        await prisma.auditLog.create({
          data: {
            module: String(module || 'SYSTEM'),
            action: String(action || 'UPDATE'),
            description: description || '',
            oldValue: safeOldValue,
            newValue: safeNewValue,
            performedBy: perfId
          }
        }).catch(() => {});
      } catch (_) {
      } finally {
        resolve();
      }
    });
  });
};

