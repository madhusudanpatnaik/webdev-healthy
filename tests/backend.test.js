/**
 * HealthyBento CRM - Backend Integration & REST API Test Suite
 * Zero external dependencies. Uses native Node.js http and assert modules.
 */

const http = require('http');
const assert = require('assert');

const BASE_URL = 'http://127.0.0.1:8090';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try {
          if (data) json = JSON.parse(data);
        } catch (_) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json,
          raw: data
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('\n========================================');
  console.log('HealthyBento CRM - Backend API Test Suite');
  console.log('========================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`FAIL: ${name}`);
      console.error(`   Error: ${err.message}`);
      failed++;
    }
  }

  // 1. Health check
  await test('GET /api/health returns 200 with service metadata', async () => {
    const res = await request('GET', '/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'ok');
    assert.strictEqual(res.data.service, 'HealthyBento REST API');
    assert(typeof res.data.uptime === 'number');
    assert(typeof res.data.totalOrders === 'number');
  });

  // 2. Full state hydration
  await test('GET /api/state returns all CRM entities', async () => {
    const res = await request('GET', '/api/state');
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.data.zones));
    assert(Array.isArray(res.data.templates));
    assert(Array.isArray(res.data.addons));
    assert(Array.isArray(res.data.customers));
    assert(Array.isArray(res.data.orders));
    assert(Array.isArray(res.data.kitchenChecklist));
    assert(res.data.tally && typeof res.data.tally.totalBentos === 'number');
  });

  // 3. Dashboard stats
  await test('GET /api/dashboard/stats computes live KPI telemetry', async () => {
    const res = await request('GET', '/api/dashboard/stats');
    assert.strictEqual(res.status, 200);
    assert(typeof res.data.totalRevenueToday === 'number');
    assert(typeof res.data.ordersCount === 'number');
    assert(typeof res.data.activeSubscriptions === 'number');
    assert(res.data.ordersByStatus && typeof res.data.ordersByStatus.received === 'number');
  });

  // 4. Order validation
  await test('POST /api/orders rejects invalid payload with 422 Unprocessable Entity', async () => {
    const res = await request('POST', '/api/orders', {
      customerName: '',
      phone: '123'
    });
    assert.strictEqual(res.status, 422);
    assert(res.data.error === 'Validation Failed');
    assert(Array.isArray(res.data.details));
  });

  // 5. Order creation
  let createdOrderId = null;
  await test('POST /api/orders creates valid order with computed totals & atomic save', async () => {
    const res = await request('POST', '/api/orders', {
      customerName: 'Sita Rama Raju',
      phone: '+91 98480 55667',
      company: 'Tech Mahindra SEZ, Rushikonda IT Hills',
      zoneId: 'rushikonda',
      templateId: 'veg_classic',
      diet: 'veg',
      addons: ['addon_eggs', 'addon_paneer'],
      deliverySlot: '12:30 PM'
    });
    assert.strictEqual(res.status, 201);
    assert(res.data.id && res.data.id.startsWith('HB-'));
    assert.strictEqual(res.data.customerName, 'Sita Rama Raju');
    assert.strictEqual(res.data.status, 'received');
    assert(typeof res.data.totalPrice === 'number' && res.data.totalPrice > 180);
    createdOrderId = res.data.id;
  });

  // 6. Order status transition
  await test('PATCH /api/orders/:id/status progresses order through pipeline', async () => {
    assert(createdOrderId, 'No created order ID to test');
    const res = await request('PATCH', `/api/orders/${createdOrderId}/status`, { status: 'prep' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'prep');
    assert(res.data.prepAt, 'prepAt timestamp should be set');
  });

  // 7. Order status transition validation
  await test('PATCH /api/orders/:id/status rejects invalid status with 400 Bad Request', async () => {
    const res = await request('PATCH', `/api/orders/${createdOrderId}/status`, { status: 'flying_drone' });
    assert.strictEqual(res.status, 400);
  });

  // 8. Order detail retrieval
  await test('GET /api/orders/:id returns single order', async () => {
    const res = await request('GET', `/api/orders/${createdOrderId}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.id, createdOrderId);
  });

  // 9. Customer creation
  let createdCustId = null;
  await test('POST /api/customers registers new subscriber', async () => {
    const res = await request('POST', '/api/customers', {
      name: 'Venkata Satyanarayana',
      phone: '+91 98480 33445',
      company: 'HSBC Global Solutions, Waltair Uplands',
      zoneId: 'siripuram',
      diet: 'nonveg',
      plan: '20-Day Monthly Power Bento',
      deliverySlot: '12:45 PM'
    });
    assert.strictEqual(res.status, 201);
    assert(res.data.id && res.data.id.startsWith('CUST-'));
    assert.strictEqual(res.data.status, 'active');
    createdCustId = res.data.id;
  });

  // 10. Customer pause toggle
  await test('PATCH /api/customers/:id/pause toggles active/paused state', async () => {
    assert(createdCustId);
    const res = await request('PATCH', `/api/customers/${createdCustId}/pause`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'paused');

    // Toggle back
    const res2 = await request('PATCH', `/api/customers/${createdCustId}/pause`);
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.data.status, 'active');
  });

  // 11. Zone thermal temperature update
  await test('PATCH /api/zones/:id/temp updates fleet thermal bag reading', async () => {
    const res = await request('PATCH', '/api/zones/rushikonda/temp', { temp: '66°C' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.temp, '66°C');
  });

  // 12. Kitchen checklist item toggle
  await test('PATCH /api/kitchen/checklist toggles batch preparation task', async () => {
    const res = await request('PATCH', '/api/kitchen/checklist', { id: 'step_1', done: true });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.done, true);
  });

  // 13. Kitchen checklist reset
  await test('POST /api/kitchen/checklist/reset resets shift checklist', async () => {
    const res = await request('POST', '/api/kitchen/checklist/reset');
    assert.strictEqual(res.status, 200);
    assert(res.data.checklist.every(item => item.done === false));
  });

  // 14. Clean database reset
  await test('POST /api/reset cleanly restores database from seed.json', async () => {
    const res = await request('POST', '/api/reset');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
  });

  console.log('\n----------------------------------------');
  console.log(`Results: ${passed} passed, ${failed} failed.`);
  console.log('----------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
