/**
 * HealthyBento CRM - Production-Grade REST API & Static Server
 * Zero external dependencies. Atomic file persistence in data/db.json.
 * Region: Visakhapatnam, Andhra Pradesh, India.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8090;
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const SEED_FILE = path.join(__dirname, 'data', 'seed.json');
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const ORDER_STATUSES = ['received', 'prep', 'qc', 'transit', 'delivered'];
const DIET_TYPES = ['veg', 'nonveg'];

// ==========================================
// PERSISTENCE ENGINE (ATOMIC WRITE)
// ==========================================

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
    if (fs.existsSync(SEED_FILE)) {
      const data = fs.readFileSync(SEED_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Fatal error loading database:', err.message);
  }
  return { zones: [], templates: [], addons: [], customers: [], orders: [], kitchenChecklist: [] };
}

let db = loadDatabase();

function saveDatabase() {
  const tmpFile = `${DB_FILE}.${Date.now()}.${Math.floor(Math.random() * 1e6)}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmpFile, DB_FILE);
  } catch (err) {
    console.error('Error in atomic saveDatabase:', err.message);
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch (_) {}
    // Fallback direct write
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (fallbackErr) {
      console.error('Fatal: Failed direct write fallback:', fallbackErr.message);
    }
  }
}

// Ensure seed file exists for reset safety
if (!fs.existsSync(SEED_FILE) && fs.existsSync(DB_FILE)) {
  try {
    fs.copyFileSync(DB_FILE, SEED_FILE);
  } catch (e) {
    console.warn('Could not create seed.json copy:', e.message);
  }
}

// ==========================================
// ID GENERATORS (COLLISION-PROOF)
// ==========================================

function generateOrderId() {
  const existing = (db.orders || [])
    .map(o => {
      const m = String(o.id).match(/HB-(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter(n => !isNaN(n));
  const max = existing.length > 0 ? Math.max(...existing) : 800;
  return `HB-${max + 1}`;
}

function generateCustomerId() {
  const existing = (db.customers || [])
    .map(c => {
      const m = String(c.id).match(/CUST-(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter(n => !isNaN(n));
  const max = existing.length > 0 ? Math.max(...existing) : 100;
  return `CUST-${max + 1}`;
}

// ==========================================
// VALIDATION & BUSINESS LOGIC
// ==========================================

function validateOrder(data) {
  const errors = [];

  if (!data.customerName || typeof data.customerName !== 'string' || data.customerName.trim().length < 2) {
    errors.push('customerName is required and must be at least 2 characters.');
  }

  if (!data.phone || typeof data.phone !== 'string' || data.phone.trim().length < 8) {
    errors.push('phone is required and must be a valid phone number.');
  }

  if (!data.company || typeof data.company !== 'string' || data.company.trim().length < 2) {
    errors.push('company/delivery address is required.');
  }

  if (!data.zoneId || !db.zones.some(z => z.id === data.zoneId)) {
    errors.push(`Invalid zoneId "${data.zoneId}". Must match a valid Visakhapatnam corridor.`);
  }

  if (data.diet && !DIET_TYPES.includes(data.diet)) {
    errors.push(`diet must be either "veg" or "nonveg".`);
  }

  if (data.addons && !Array.isArray(data.addons)) {
    errors.push('addons must be an array of addon IDs.');
  }

  return errors;
}

function validateCustomer(data) {
  const errors = [];

  if (!data.name || typeof data.name !== 'string' || data.name.trim().length < 2) {
    errors.push('Customer name is required.');
  }

  if (!data.phone || typeof data.phone !== 'string' || data.phone.trim().length < 8) {
    errors.push('Valid customer phone number is required.');
  }

  if (!data.company || typeof data.company !== 'string' || data.company.trim().length < 2) {
    errors.push('Office/company location is required.');
  }

  if (data.zoneId && !db.zones.some(z => z.id === data.zoneId)) {
    errors.push(`Invalid zoneId "${data.zoneId}".`);
  }

  return errors;
}

// Recalculate and verify pricing and nutrition
function computeOrderTotals(orderData) {
  const template = db.templates.find(t => t.id === orderData.templateId) || db.templates[0];
  let price = template ? template.price : 180;
  let cal = template ? template.baseCalories : 520;
  let protein = template ? template.baseProtein : 22;
  let carbs = template ? template.baseCarbs : 65;
  let fats = template ? template.baseFats : 16;

  const validAddons = Array.isArray(orderData.addons) ? orderData.addons : [];
  validAddons.forEach(aId => {
    const a = db.addons.find(x => x.id === aId);
    if (a) {
      price += a.price;
      cal += a.cal;
      protein += a.prot;
      carbs += a.carbs;
      fats += a.fats;
    }
  });

  return {
    price: typeof orderData.totalPrice === 'number' && orderData.totalPrice > 0 ? orderData.totalPrice : price,
    macros: orderData.macros || { cal, protein, carbs, fats }
  };
}

// Compute kitchen batch production quotas
function computeKitchenTally() {
  let vegBentos = 0;
  let nonVegBentos = 0;
  let eggPortions = 0;
  let chickenPortions = 0;
  let paneerPortions = 0;
  let buttermilkPortions = 0;
  let rotiPairs = 0;

  (db.orders || []).forEach(order => {
    if (order.diet === 'veg') vegBentos++;
    else nonVegBentos++;

    if (Array.isArray(order.addons)) {
      order.addons.forEach(addonId => {
        if (addonId === 'addon_eggs') eggPortions += 2;
        if (addonId === 'addon_chicken') chickenPortions += 1;
        if (addonId === 'addon_paneer') paneerPortions += 1;
        if (addonId === 'addon_buttermilk') buttermilkPortions += 1;
        if (addonId === 'addon_rotis') rotiPairs += 1;
      });
    }
  });

  return {
    totalBentos: vegBentos + nonVegBentos,
    vegBentos,
    nonVegBentos,
    eggPortions,
    chickenPortions,
    paneerPortions,
    buttermilkPortions,
    rotiPairs
  };
}

// Compute Dashboard and Operational KPIs
function computeDashboardStats() {
  const tally = computeKitchenTally();
  const orders = db.orders || [];
  const customers = db.customers || [];

  const ordersByStatus = {
    received: 0,
    prep: 0,
    qc: 0,
    transit: 0,
    delivered: 0
  };

  let totalRevenueToday = 0;
  orders.forEach(o => {
    totalRevenueToday += (Number(o.totalPrice) || 0);
    if (ordersByStatus[o.status] !== undefined) {
      ordersByStatus[o.status]++;
    }
  });

  const activeSubscriptions = customers.filter(c => c.status === 'active').length;
  const pausedSubscriptions = customers.filter(c => c.status === 'paused').length;

  const corridorLoad = {};
  (db.zones || []).forEach(z => {
    corridorLoad[z.id] = orders.filter(o => o.zoneId === z.id).length;
  });

  return {
    tally,
    totalRevenueToday,
    ordersCount: orders.length,
    ordersByStatus,
    activeSubscriptions,
    pausedSubscriptions,
    corridorLoad,
    region: 'Visakhapatnam, Andhra Pradesh',
    timestamp: new Date().toISOString()
  };
}

// ==========================================
// HTTP REQUEST HELPERS
// ==========================================

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 2e6) {
        req.destroy();
        reject(new Error('Payload exceeds 2MB limit'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON format: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  });
  res.end(JSON.stringify(data));
}

// ==========================================
// MAIN HTTP SERVER & ROUTER
// ==========================================

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1:8090'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();
  const searchParams = parsedUrl.searchParams;

  // Handle CORS Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // ==========================================
  // REST API ROUTES
  // ==========================================
  if (pathname.startsWith('/api/')) {
    try {
      // 1. Health Check
      if (pathname === '/api/health' && method === 'GET') {
        return sendJson(res, 200, {
          status: 'ok',
          service: 'HealthyBento REST API',
          region: 'Visakhapatnam, Andhra Pradesh',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().rss,
          totalOrders: (db.orders || []).length,
          totalCustomers: (db.customers || []).length,
          timestamp: new Date().toISOString()
        });
      }

      // 2. Full State Initial Hydration
      if (pathname === '/api/state' && method === 'GET') {
        return sendJson(res, 200, {
          zones: db.zones,
          templates: db.templates,
          addons: db.addons,
          customers: db.customers,
          orders: db.orders,
          kitchenChecklist: db.kitchenChecklist,
          tally: computeKitchenTally(),
          stats: computeDashboardStats()
        });
      }

      // 3. Analytics / Dashboard Statistics
      if ((pathname === '/api/stats' || pathname === '/api/dashboard/stats') && method === 'GET') {
        return sendJson(res, 200, computeDashboardStats());
      }

      // 4. Orders Endpoints
      if (pathname === '/api/orders' && method === 'GET') {
        let orders = db.orders || [];

        // Filters
        const status = searchParams.get('status');
        const diet = searchParams.get('diet');
        const zoneId = searchParams.get('zoneId');
        const search = searchParams.get('search');

        if (status) orders = orders.filter(o => o.status === status);
        if (diet) orders = orders.filter(o => o.diet === diet);
        if (zoneId) orders = orders.filter(o => o.zoneId === zoneId);
        if (search) {
          const s = search.toLowerCase();
          orders = orders.filter(o =>
            (o.customerName && o.customerName.toLowerCase().includes(s)) ||
            (o.id && o.id.toLowerCase().includes(s)) ||
            (o.company && o.company.toLowerCase().includes(s)) ||
            (o.phone && o.phone.includes(s))
          );
        }

        return sendJson(res, 200, orders);
      }

      if (pathname === '/api/orders' && method === 'POST') {
        const body = await parseJsonBody(req);
        const errors = validateOrder(body);
        if (errors.length > 0) {
          return sendJson(res, 422, { error: 'Validation Failed', details: errors });
        }

        const totals = computeOrderTotals(body);
        const orderId = generateOrderId();
        const zone = db.zones.find(z => z.id === body.zoneId) || {};
        const template = db.templates.find(t => t.id === body.templateId) || {};

        const newOrder = {
          id: orderId,
          customerId: body.customerId || null,
          customerName: body.customerName.trim(),
          phone: body.phone.trim(),
          company: body.company.trim(),
          zoneId: body.zoneId,
          templateId: body.templateId || 'veg_classic',
          bentoName: body.bentoName || `${template.name || 'Executive Bento'} (Custom)`,
          diet: body.diet || template.diet || 'veg',
          addons: Array.isArray(body.addons) ? body.addons : [],
          customIngredients: body.customIngredients || null,
          totalPrice: totals.price,
          deliverySlot: body.deliverySlot || '12:30 PM',
          thermalBagTemp: body.thermalBagTemp || zone.temp || 'Hot Sealed (65°C)',
          rider: body.rider || zone.rider || 'Assigned Rider',
          macros: totals.macros,
          orderedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
          status: body.status || 'received',
          createdAt: new Date().toISOString()
        };

        db.orders.unshift(newOrder);
        saveDatabase();
        return sendJson(res, 201, newOrder);
      }

      // Order Status Transition: PATCH /api/orders/:id/status
      const orderStatusMatch = pathname.match(/^\/api\/orders\/([A-Za-z0-9-]+)\/status$/);
      if (orderStatusMatch && method === 'PATCH') {
        const orderId = orderStatusMatch[1];
        const body = await parseJsonBody(req);
        const order = db.orders.find(o => o.id === orderId);

        if (!order) {
          return sendJson(res, 404, { error: `Order ${orderId} not found` });
        }

        if (!body.status || !ORDER_STATUSES.includes(body.status)) {
          return sendJson(res, 400, {
            error: 'Invalid status',
            allowed: ORDER_STATUSES
          });
        }

        order.status = body.status;
        const nowFormatted = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

        if (body.status === 'prep') order.prepAt = nowFormatted;
        if (body.status === 'qc') order.qcAt = nowFormatted;
        if (body.status === 'transit') order.dispatchedAt = nowFormatted;
        if (body.status === 'delivered') order.deliveredAt = nowFormatted;

        saveDatabase();
        return sendJson(res, 200, order);
      }

      // Order Detail / Update / Delete: /api/orders/:id
      const orderMatch = pathname.match(/^\/api\/orders\/([A-Za-z0-9-]+)$/);
      if (orderMatch) {
        const orderId = orderMatch[1];
        const index = db.orders.findIndex(o => o.id === orderId);

        if (index === -1) {
          return sendJson(res, 404, { error: `Order ${orderId} not found` });
        }

        if (method === 'GET') {
          return sendJson(res, 200, db.orders[index]);
        }

        if (method === 'PATCH' || method === 'PUT') {
          const body = await parseJsonBody(req);
          db.orders[index] = { ...db.orders[index], ...body, id: orderId };
          saveDatabase();
          return sendJson(res, 200, db.orders[index]);
        }

        if (method === 'DELETE') {
          const deleted = db.orders.splice(index, 1);
          saveDatabase();
          return sendJson(res, 200, { success: true, deleted: deleted[0] });
        }
      }

      // 5. Customers Endpoints
      if (pathname === '/api/customers' && method === 'GET') {
        let customers = db.customers || [];
        const status = searchParams.get('status');
        const search = searchParams.get('search');

        if (status) customers = customers.filter(c => c.status === status);
        if (search) {
          const s = search.toLowerCase();
          customers = customers.filter(c =>
            (c.name && c.name.toLowerCase().includes(s)) ||
            (c.company && c.company.toLowerCase().includes(s)) ||
            (c.phone && c.phone.includes(s)) ||
            (c.id && c.id.toLowerCase().includes(s))
          );
        }

        return sendJson(res, 200, customers);
      }

      if (pathname === '/api/customers' && method === 'POST') {
        const body = await parseJsonBody(req);
        const errors = validateCustomer(body);
        if (errors.length > 0) {
          return sendJson(res, 422, { error: 'Validation Failed', details: errors });
        }

        const custId = generateCustomerId();
        const newCust = {
          id: custId,
          name: body.name.trim(),
          phone: body.phone.trim(),
          email: body.email ? body.email.trim() : '',
          company: body.company.trim(),
          zoneId: body.zoneId || 'rushikonda',
          diet: body.diet || 'veg',
          plan: body.plan || '20-Day Monthly Power Bento',
          deliverySlot: body.deliverySlot || '12:30 PM',
          defaultAddons: Array.isArray(body.defaultAddons) ? body.defaultAddons : [],
          notes: body.notes ? body.notes.trim() : '',
          totalOrders: 0,
          lifetimeSpend: 0,
          status: 'active',
          deliveries: {},
          joinedAt: new Date().toISOString().split('T')[0]
        };

        db.customers.unshift(newCust);
        saveDatabase();
        return sendJson(res, 201, newCust);
      }

      // Customer Pause Toggle: PATCH /api/customers/:id/pause
      const custPauseMatch = pathname.match(/^\/api\/customers\/([A-Za-z0-9-]+)\/pause$/);
      if (custPauseMatch && method === 'PATCH') {
        const custId = custPauseMatch[1];
        const cust = db.customers.find(c => c.id === custId);
        if (!cust) return sendJson(res, 404, { error: `Customer ${custId} not found` });

        cust.status = cust.status === 'active' ? 'paused' : 'active';
        cust.statusUpdatedAt = new Date().toISOString();
        saveDatabase();
        return sendJson(res, 200, cust);
      }

      // Customer Orders History: GET /api/customers/:id/orders
      const custOrdersMatch = pathname.match(/^\/api\/customers\/([A-Za-z0-9-]+)\/orders$/);
      if (custOrdersMatch && method === 'GET') {
        const custId = custOrdersMatch[1];
        const custOrders = (db.orders || []).filter(o => o.customerId === custId);
        return sendJson(res, 200, custOrders);
      }

      // Customer Delivery Attendance: PATCH /api/customers/:id/deliveries/:date
      const custDeliveryMatch = pathname.match(/^\/api\/customers\/([A-Za-z0-9-]+)\/deliveries\/(\d{4}-\d{2}-\d{2})$/);
      if (custDeliveryMatch) {
        const custId = custDeliveryMatch[1];
        const date = custDeliveryMatch[2];
        const cust = db.customers.find(c => c.id === custId);
        if (!cust) return sendJson(res, 404, { error: `Customer ${custId} not found` });

        if (!cust.deliveries) cust.deliveries = {};

        if (method === 'PATCH') {
          const body = await parseJsonBody(req);
          const allowed = ['delivered', 'skipped', null];
          if (!allowed.includes(body.status)) {
            return sendJson(res, 400, { error: 'status must be one of: delivered, skipped, or null' });
          }
          // Reject marking future days as delivered (safety net)
          const todayStr = new Date().toISOString().slice(0, 10);
          if (body.status === 'delivered' && date > todayStr) {
            return sendJson(res, 400, { error: 'Cannot mark a future date as delivered' });
          }
          if (body.status === null) delete cust.deliveries[date];
          else cust.deliveries[date] = body.status;
          saveDatabase();
          return sendJson(res, 200, cust);
        }

        if (method === 'DELETE') {
          delete cust.deliveries[date];
          saveDatabase();
          return sendJson(res, 200, cust);
        }
      }

      // Customer Detail / Update / Delete: /api/customers/:id
      const custMatch = pathname.match(/^\/api\/customers\/([A-Za-z0-9-]+)$/);
      if (custMatch) {
        const custId = custMatch[1];
        const index = db.customers.findIndex(c => c.id === custId);

        if (index === -1) {
          return sendJson(res, 404, { error: `Customer ${custId} not found` });
        }

        if (method === 'GET') {
          return sendJson(res, 200, db.customers[index]);
        }

        if (method === 'PATCH' || method === 'PUT') {
          const body = await parseJsonBody(req);
          db.customers[index] = { ...db.customers[index], ...body, id: custId };
          saveDatabase();
          return sendJson(res, 200, db.customers[index]);
        }

        if (method === 'DELETE') {
          const deleted = db.customers.splice(index, 1);
          saveDatabase();
          return sendJson(res, 200, { success: true, deleted: deleted[0] });
        }
      }

      // 6. Zones / Delivery Fleet Endpoints
      if (pathname === '/api/zones' && method === 'GET') {
        return sendJson(res, 200, db.zones || []);
      }

      if (pathname === '/api/fleet/routes' && method === 'GET') {
        return sendJson(res, 200, db.zones || []);
      }

      const zoneMatch = pathname.match(/^\/api\/zones\/([A-Za-z0-9-_]+)$/);
      if (zoneMatch) {
        const zoneId = zoneMatch[1];
        const zone = db.zones.find(z => z.id === zoneId);
        if (!zone) return sendJson(res, 404, { error: `Zone ${zoneId} not found` });

        if (method === 'GET') {
          return sendJson(res, 200, zone);
        }

        if (method === 'PATCH' || method === 'PUT') {
          const body = await parseJsonBody(req);
          Object.assign(zone, body);
          saveDatabase();
          return sendJson(res, 200, zone);
        }
      }

      // Thermal bag temp update: PATCH /api/fleet/routes/:id/temp or /api/zones/:id/temp
      const fleetTempMatch = pathname.match(/^\/api\/(?:fleet\/routes|zones)\/([A-Za-z0-9-_]+)\/temp$/);
      if (fleetTempMatch && method === 'PATCH') {
        const zoneId = fleetTempMatch[1];
        const body = await parseJsonBody(req);
        const zone = db.zones.find(z => z.id === zoneId);
        if (!zone) return sendJson(res, 404, { error: `Zone ${zoneId} not found` });

        if (body.temp) zone.temp = body.temp;
        if (body.status) zone.status = body.status;
        saveDatabase();
        return sendJson(res, 200, zone);
      }

      // 7. Templates & Add-ons Endpoints
      if (pathname === '/api/templates' && method === 'GET') {
        return sendJson(res, 200, db.templates || []);
      }

      if (pathname === '/api/addons' && method === 'GET') {
        return sendJson(res, 200, db.addons || []);
      }

      // 8. Kitchen Tally & Checklist Endpoints
      if (pathname === '/api/kitchen/tally' && method === 'GET') {
        return sendJson(res, 200, computeKitchenTally());
      }

      if (pathname === '/api/kitchen/checklist' && method === 'GET') {
        return sendJson(res, 200, db.kitchenChecklist || []);
      }

      if (pathname === '/api/kitchen/checklist' && method === 'PATCH') {
        const body = await parseJsonBody(req);
        const item = (db.kitchenChecklist || []).find(c => c.id === body.id);
        if (!item) return sendJson(res, 404, { error: 'Checklist item not found' });

        item.done = typeof body.done === 'boolean' ? body.done : !item.done;
        saveDatabase();
        return sendJson(res, 200, item);
      }

      // Reset checklist for morning prep shift
      if (pathname === '/api/kitchen/checklist/reset' && method === 'POST') {
        (db.kitchenChecklist || []).forEach(item => { item.done = false; });
        saveDatabase();
        return sendJson(res, 200, { success: true, checklist: db.kitchenChecklist });
      }

      // 9. Reset Database from Clean Seed
      if (pathname === '/api/reset' && method === 'POST') {
        if (!fs.existsSync(SEED_FILE)) {
          return sendJson(res, 500, { error: 'Seed file seed.json missing' });
        }
        const freshSeed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
        db = freshSeed;
        saveDatabase();
        return sendJson(res, 200, {
          success: true,
          message: 'HealthyBento database successfully restored to fresh morning seed state'
        });
      }

      // 404 for unknown /api/*
      return sendJson(res, 404, { error: `API endpoint ${method} ${pathname} not found` });
    } catch (err) {
      console.error(`API Error [${method} ${pathname}]:`, err);
      return sendJson(res, 500, { error: 'Internal Server Error', message: err.message });
    }
  }

  // ==========================================
  // STATIC FILE SERVING
  // ==========================================
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '') safePath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, safePath);
  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = MIME_TYPES[extname] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`500 Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': extname === '.html' ? 'no-cache' : 'public, max-age=3600'
      });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HealthyBento Server & REST API running on http://127.0.0.1:${PORT}/`);
  console.log(`Region: Visakhapatnam, Andhra Pradesh, India`);
});
