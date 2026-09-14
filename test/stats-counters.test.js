import test from "node:test";
import assert from "node:assert/strict";
import { HTTPFacilitatorClient } from "@x402/core/server";
import app, { hasSettlementResponse } from "../src/index.js";
import { NETWORK, TOOLS } from "../src/shared.js";

// A small in-memory D1 double. It deliberately keeps the chainable D1 shape
// (prepare().bind().run()/all()/first()) while accepting the upsert/select SQL
// used by the worker. This keeps these tests independent of a local D1 server.
class FakeD1 {
  constructor() {
    this.rows = new Map();
    this.failWrites = false;
    this.statements = [];
  }

  prepare(sql) {
    const statement = new FakeStatement(this, sql);
    this.statements.push(statement);
    return statement;
  }

  clear() {
    this.rows.clear();
    this.failWrites = false;
  }

  apply(sql, args) {
    if (/^\s*create\s+table/i.test(sql)) return;

    const endpoint = args.find((arg) => typeof arg === "string" && arg.startsWith("/"));
    if (!endpoint || !sql.toLowerCase().includes("endpoint")) return;

    const row = this.rows.get(endpoint) ?? {
      endpoint,
      requests: 0,
      paid_attempts: 0,
      settled_success: 0,
      free_requests: 0,
      first_seen: null,
      last_seen: null,
    };
    const numbers = args.filter((arg) => typeof arg === "number");
    const lower = sql.toLowerCase();
    const event = args.find((arg) => typeof arg === "string" && !arg.startsWith("/") && !/^\d{4}-\d{2}-\d{2}t/i.test(arg));

    // Support both the compact four-delta upsert and event-oriented updates.
    let [requests, paid, settled, free] = numbers;
    if (numbers.length === 3) [paid, settled, free] = numbers;
    if (numbers.length < 4) requests = 1;
    if (event) {
      if (/paid[_ -]?attempt/i.test(event)) paid = 1;
      else if (/settled|success/i.test(event)) settled = 1;
      else if (/free/i.test(event)) free = 1;
    }
    if (/free_requests\s*=\s*free_requests\s*\+\s*1/i.test(sql)) free = 1;
    if (/paid_attempts\s*=\s*paid_attempts\s*\+\s*1/i.test(sql)) paid = 1;
    if (/settled_success\s*=\s*settled_success\s*\+\s*1/i.test(sql)) settled = 1;
    if (/requests\s*=\s*requests\s*\+\s*1/i.test(sql)) requests = 1;

    row.requests += Number(requests) || 0;
    row.paid_attempts += Number(paid) || 0;
    row.settled_success += Number(settled) || 0;
    row.free_requests += Number(free) || 0;
    const timestamps = args.filter((arg) => typeof arg === "string" && /^\d{4}-\d{2}-\d{2}t/i.test(arg));
    const now = timestamps[0] ?? new Date().toISOString();
    row.first_seen ??= now;
    row.last_seen = timestamps.at(-1) ?? now;
    this.rows.set(endpoint, row);
  }

  result(sql) {
    const rows = [...this.rows.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
    const lower = sql.toLowerCase();
    if (lower.includes("sum(") || lower.includes("count(*)")) {
      return {
        total_requests: rows.reduce((sum, row) => sum + row.requests, 0),
        paid_attempts: rows.reduce((sum, row) => sum + row.paid_attempts, 0),
        settled_success: rows.reduce((sum, row) => sum + row.settled_success, 0),
        free_requests: rows.reduce((sum, row) => sum + row.free_requests, 0),
      };
    }
    return rows;
  }
}

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async run() {
    if (this.db.failWrites && !/^\s*create\s+table/i.test(this.sql)) {
      throw new Error("simulated D1 write failure");
    }
    this.db.apply(this.sql, this.args);
    return { success: true, meta: {} };
  }

  async all() {
    const value = this.db.result(this.sql);
    return Array.isArray(value) ? { results: value } : { results: [value] };
  }

  async first() {
    const value = this.db.result(this.sql);
    return Array.isArray(value) ? (value[0] ?? null) : value;
  }
}

// Keep x402's real requirement and middleware flow, but prevent network I/O.
const realGetSupported = HTTPFacilitatorClient.prototype.getSupported;
const realVerify = HTTPFacilitatorClient.prototype.verify;
const realSettle = HTTPFacilitatorClient.prototype.settle;
HTTPFacilitatorClient.prototype.getSupported = async () => ({
  kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
  extensions: [],
  signers: {},
});
HTTPFacilitatorClient.prototype.verify = async () => ({ isValid: true });
HTTPFacilitatorClient.prototype.settle = async () => ({ success: true, transaction: "0xtest", network: NETWORK });
test.after(() => {
  HTTPFacilitatorClient.prototype.getSupported = realGetSupported;
  HTTPFacilitatorClient.prototype.verify = realVerify;
  HTTPFacilitatorClient.prototype.settle = realSettle;
});

const db = new FakeD1();

// The facilitator stub above accepts this structurally valid payment envelope.
// Its fixed placeholder values never sign, authorize, or reach a network.
function settledPaymentHeader(accepted) {
  return { "payment-signature": Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted,
    payload: {
      signature: `0x${"00".repeat(65)}`,
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        value: "1",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"00".repeat(32)}`,
      },
    },
  })).toString("base64") };
}

function request(path, method, headers = {}) {
  const init = { method, headers };
  if (method === "POST") {
    init.headers = { "content-type": "application/json", ...headers };
    init.body = JSON.stringify({ input: "{foo: 1,}" });
  }
  return new Request(`http://localhost${path}`, init);
}

async function fetchWithCounters(path, method, headers = {}) {
  const pending = [];
  const execution = { waitUntil(promise) { pending.push(Promise.resolve(promise)); } };
  const response = await app.fetch(request(path, method, headers), { DB: db }, execution);
  await Promise.allSettled(pending);
  return response;
}

function paymentRequired(response) {
  const encoded = response.headers.get("payment-required");
  assert.ok(encoded, "paid response must include PAYMENT-REQUIRED");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

test.beforeEach(() => db.clear());

test("settlement evidence recognizes x402 Payment-Response and native MPP Payment-Receipt", () => {
  assert.equal(hasSettlementResponse(new Response(null, { headers: { "payment-response": "x402-ok" } })), true);
  assert.equal(hasSettlementResponse(new Response(null, { headers: { "payment-receipt": "mpp-ok" } })), true);
  assert.equal(hasSettlementResponse(new Response(null, { headers: { "www-authenticate": "Payment ..." } })), false);
});

test("unpaid GET increments requests and paid_attempts, but not settled_success", async () => {
  const response = await fetchWithCounters("/repair/json", "GET");
  assert.equal(response.status, 402);
  const row = db.rows.get("/repair/json");
  assert.equal(row.requests, 1);
  assert.equal(row.paid_attempts, 1);
  assert.equal(row.settled_success, 0);
});

test("successful settled POST increments each paid counter exactly once", async () => {
  const unpaid = await fetchWithCounters("/repair/json", "POST");
  const { accepts } = paymentRequired(unpaid);
  db.clear();
  const response = await fetchWithCounters("/repair/json", "POST", settledPaymentHeader(accepts[0]));
  assert.equal(response.status, 200);
  const row = db.rows.get("/repair/json");
  assert.equal(row.requests, 1);
  assert.equal(row.paid_attempts, 1);
  assert.equal(row.settled_success, 1);
});

test("free /diagnose increments free_requests and not paid_attempts", async () => {
  const response = await fetchWithCounters("/diagnose", "POST");
  assert.equal(response.status, 200);
  const row = db.rows.get("/diagnose");
  assert.equal(row.requests, 1);
  assert.equal(row.free_requests, 1);
  assert.equal(row.paid_attempts, 0);

  const stats = await fetchWithCounters("/stats", "GET");
  assert.equal((await stats.json()).by_endpoint["/diagnose"].free_requests, 1);
});

test("/stats returns totals and all nine paid endpoint keys", async () => {
  await fetchWithCounters("/repair/json", "GET");
  const response = await fetchWithCounters("/stats", "GET");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body.counters).sort(), [
    "free_requests", "paid_attempts", "settled_success", "total_requests",
  ].sort());
  for (const path of Object.keys(TOOLS)) {
    assert.ok(body.by_endpoint[path], `missing paid endpoint counter for ${path}`);
    assert.deepEqual(Object.keys(body.by_endpoint[path]).sort(), [
      "first_seen", "free_requests", "last_seen", "paid_attempts", "requests", "settled_success",
    ].sort());
  }
  assert.deepEqual(body.counters, {
    total_requests: 1,
    paid_attempts: 1,
    settled_success: 0,
    free_requests: 0,
  });
  assert.equal(body.by_endpoint["/repair/json"].requests, 1);
  assert.ok(body.by_endpoint["/repair/json"].first_seen);
  assert.ok(body.by_endpoint["/repair/json"].last_seen);
});

test("counter write failures do not alter the original response", async () => {
  const baseline = await fetchWithCounters("/diagnose", "POST");
  const baselineStatus = baseline.status;
  const baselineBody = await baseline.json();
  db.clear();
  db.failWrites = true;
  const response = await fetchWithCounters("/diagnose", "POST");
  assert.equal(response.status, baselineStatus);
  assert.deepEqual(await response.json(), baselineBody);
});
