import test from "node:test";
import assert from "node:assert/strict";
import { HTTPFacilitatorClient } from "@x402/core/server";
import app from "../src/index.js";
import { NETWORK } from "../src/shared.js";

// This D1 double implements only the worker's allowance, counters, and
// lifecycle queries. It lets the allowance path remain fully offline.
class TrialD1 {
  constructor() {
    this.allowances = new Map();
    this.rows = new Map();
    this.events = [];
  }

  prepare(sql) {
    const db = this;
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async run() {
        if (/insert into free_trial_allowances/i.test(sql)) {
          const [hash, reservation] = args;
          const prior = db.allowances.get(hash);
          if (!prior || !prior.last_success_at) db.allowances.set(hash, { reservation_id: reservation, last_success_at: null });
        } else if (/update free_trial_allowances/i.test(sql)) {
          const [hash, reservation] = args;
          const prior = db.allowances.get(hash);
          if (prior?.reservation_id === reservation) {
            if (/last_success_at/i.test(sql)) prior.last_success_at = "now";
            prior.reservation_id = null;
          }
        } else if (/insert into endpoint_counters/i.test(sql)) {
          const [endpoint, paid, settled, free] = args;
          const row = db.rows.get(endpoint) ?? { requests: 0, paid_attempts: 0, settled_success: 0, free_requests: 0 };
          row.requests += 1;
          row.paid_attempts += paid;
          row.settled_success += settled;
          row.free_requests += free;
          db.rows.set(endpoint, row);
        } else if (/insert into payment_lifecycle_events/i.test(sql)) {
          db.events.push(Object.fromEntries(["route", "outcome", "payer_class", "client_class"].map((key, i) => [key, args[i]])));
        }
        return { success: true };
      },
      async first() {
        if (/select reservation_id/i.test(sql)) {
          const [hash, reservation] = args;
          const allowance = db.allowances.get(hash);
          return allowance?.reservation_id === reservation ? { reservation_id: reservation } : null;
        }
        return null;
      },
      async all() {
        if (/payment_lifecycle_events/i.test(sql)) {
          const grouped = new Map();
          for (const event of db.events) {
            const key = `${event.outcome}:${event.payer_class}`;
            grouped.set(key, (grouped.get(key) ?? 0) + 1);
          }
          return { results: [...grouped].map(([key, count]) => {
            const [outcome, payer_class] = key.split(":");
            return { outcome, payer_class, count };
          }) };
        }
        return { results: [...db.rows].map(([endpoint, row]) => ({ endpoint, ...row, first_seen: "now", last_seen: "now" })) };
      },
    };
  }
}

const originalGetSupported = HTTPFacilitatorClient.prototype.getSupported;
HTTPFacilitatorClient.prototype.getSupported = async () => ({
  kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
  extensions: [],
  signers: {},
});
test.after(() => { HTTPFacilitatorClient.prototype.getSupported = originalGetSupported; });

async function fetch(path, body, db, ip = "203.0.113.7") {
  const pending = [];
  const response = await app.fetch(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, "user-agent": "agent-test/1.0" },
    body: JSON.stringify(body),
  }), { DB: db, FREE_TRIAL_SALT: "test-only-salt" }, {
    waitUntil(promise) { pending.push(Promise.resolve(promise)); },
  });
  await Promise.all(pending);
  return response;
}

test("one compute trial succeeds, then the same client receives the normal 402", async () => {
  const db = new TrialD1();
  const first = await fetch("/repair/json", { input: "{foo: 1,}" }, db);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-free-trial"), "true");
  assert.equal((await first.json()).normal_price, "$0.005");
  assert.deepEqual(db.rows.get("/repair/json"), {
    requests: 1, paid_attempts: 0, settled_success: 0, free_requests: 1,
  });

  const second = await fetch("/repair/json", { input: "{foo: 1,}" }, db);
  assert.equal(second.status, 402);
  assert.equal(db.rows.get("/repair/json").free_requests, 1);
  assert.equal(db.rows.get("/repair/json").paid_attempts, 1);
  assert.equal(db.rows.get("/repair/json").settled_success, 0);
  assert.deepEqual(db.events.at(-1), {
    route: "/repair/json",
    outcome: "challenge_issued",
    payer_class: "no_payment_header",
    client_class: "agent_client",
  });
});

test("network-backed routes never consume or receive a free trial", async () => {
  const db = new TrialD1();
  const response = await fetch("/domain/whois", { domain: "example.com" }, db);
  assert.equal(response.status, 402);
  assert.equal(db.rows.get("/domain/whois").free_requests, 0);
  assert.equal(db.rows.get("/domain/whois").paid_attempts, 1);
});

test("the successful allowance is shared by all compute routes", async () => {
  const db = new TrialD1();
  const first = await fetch("/repair/json", { input: "{foo: 1,}" }, db);
  assert.equal(first.status, 200);

  const second = await fetch("/yaml/tojson", { input: "name: blocked" }, db);
  assert.equal(second.status, 402);
  assert.equal(db.rows.get("/repair/json").free_requests, 1);
  assert.equal(db.rows.get("/yaml/tojson").free_requests, 0);
  assert.equal(db.rows.get("/yaml/tojson").paid_attempts, 1);
});

test("a failed free-trial handler does not consume the allowance", async () => {
  const db = new TrialD1();
  const failed = await fetch("/cron/nextrun", { expr: "not a cron" }, db);
  assert.equal(failed.status, 422);
  assert.equal(db.rows.get("/cron/nextrun").free_requests, 0);
  assert.equal(db.rows.get("/cron/nextrun").paid_attempts, 0);
  assert.deepEqual(db.events.at(-1), {
    route: "/cron/nextrun",
    outcome: "handler_failed",
    payer_class: "no_payment_header",
    client_class: "agent_client",
  });

  const retry = await fetch("/cron/nextrun", { expr: "0 * * * *" }, db);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get("x-free-trial"), "true");
  assert.equal(db.rows.get("/cron/nextrun").free_requests, 1);
});
