import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/studio/payment-status-sync.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { startPaymentStatusSync } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const pending = { id: "saved-order", status: "awaiting-payment" };
const paid = { ...pending, status: "captured", charged: true };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function clock() {
  let time = 0, nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer: id => timers.delete(id),
    count: () => timers.size,
    advance: async duration => {
      const end = time + duration;
      await flush();
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}

test("return checks the saved invoice immediately, confirms payment and stops checking", async () => {
  const time = clock(), seen = [], calls = [];
  const sync = startPaymentStatusSync({ ...time, isActive: () => true,
    check: async () => { calls.push(time.now()); return calls.length === 1 ? pending : paid; },
    onOrder: order => seen.push(order),
  });
  await flush();
  assert.deepEqual(seen, [pending]);
  await time.advance(15_000);
  assert.deepEqual(seen, [pending, paid]);
  sync.refresh();
  await time.advance(120_000);
  assert.deepEqual(calls, [0, 15_000]);
  assert.equal(time.count(), 0);
});

test("all nonpending server states stop background checks without inventing success", async () => {
  for (const status of ["submitting", "uncertain", "declined", "refund-pending", "partially-refunded", "refunded"]) {
    const time = clock(), seen = [];
    let calls = 0;
    const result = { ...pending, status };
    const sync = startPaymentStatusSync({ ...time, isActive: () => true,
      check: async () => { calls += 1; return result; }, onOrder: order => seen.push(order),
    });
    await flush();
    sync.refresh();
    await time.advance(120_000);
    assert.equal(calls, 1, status);
    assert.deepEqual(seen, [result]);
  }
});

test("leaving a film drops its late result and cancels future status checks", async () => {
  const time = clock(), request = deferred(), seen = [];
  let calls = 0;
  const sync = startPaymentStatusSync({ ...time, isActive: () => true,
    check: () => { calls += 1; return request.promise; }, onOrder: order => seen.push(order),
  });
  sync.stop();
  request.resolve(paid);
  await flush();
  sync.refresh();
  await time.advance(120_000);
  assert.deepEqual(seen, []);
  assert.equal(calls, 1);
  assert.equal(time.count(), 0);

  const scheduled = startPaymentStatusSync({ ...time, isActive: () => true,
    check: async () => pending, onOrder: () => {},
  });
  await flush();
  assert.equal(time.count(), 1);
  scheduled.stop();
  assert.equal(time.count(), 0);
});

test("focus and visibility events cannot overlap requests or bypass the minimum interval", async () => {
  const time = clock(), request = deferred(), calls = [];
  const sync = startPaymentStatusSync({ ...time, isActive: () => true,
    check: () => { calls.push(time.now()); return calls.length === 1 ? request.promise : Promise.resolve(pending); },
    onOrder: () => {},
  });
  sync.refresh(); sync.refresh();
  await time.advance(5_000);
  sync.refresh();
  assert.deepEqual(calls, [0]);
  request.resolve(pending);
  await flush();
  sync.refresh(); sync.refresh();
  await time.advance(9_999);
  assert.deepEqual(calls, [0]);
  await time.advance(1);
  assert.deepEqual(calls, [0, 15_000]);
  sync.stop();
});

test("hidden or busy views skip requests and stop scheduling until a later return", async () => {
  const time = clock(), calls = [];
  let active = false;
  const sync = startPaymentStatusSync({ ...time, isActive: () => active,
    check: async () => { calls.push(time.now()); return pending; }, onOrder: () => {},
  });
  await time.advance(120_000);
  assert.deepEqual(calls, []);
  assert.equal(time.count(), 0);
  active = true;
  sync.refresh();
  await flush();
  assert.deepEqual(calls, [120_000]);
  active = false;
  await time.advance(30_000);
  assert.deepEqual(calls, [120_000]);
  active = true;
  sync.refresh();
  await flush();
  assert.deepEqual(calls, [120_000, 150_000]);
  sync.stop();
});

test("temporary errors preserve state and can recover within the same bounded window", async () => {
  const time = clock(), seen = [];
  let calls = 0;
  startPaymentStatusSync({ ...time, isActive: () => true,
    check: async () => { calls += 1; if (calls === 1) throw new Error("temporary network failure"); return paid; },
    onOrder: order => seen.push(order),
  });
  await flush();
  assert.deepEqual(seen, []);
  await time.advance(15_000);
  assert.deepEqual(seen, [paid]);
  assert.equal(calls, 2);
  assert.equal(time.count(), 0);
});

test("checks and failures share an eight-request budget; a later focus restarts it with throttling", async () => {
  const time = clock(), calls = [];
  const sync = startPaymentStatusSync({ ...time, isActive: () => true,
    check: async () => { calls.push(time.now()); throw new Error("offline"); }, onOrder: () => assert.fail("failed read is not a payment update"),
  });
  await time.advance(105_000);
  assert.equal(calls.length, 8);
  assert.equal(time.count(), 0);
  sync.refresh(); sync.refresh();
  await time.advance(14_999);
  assert.equal(calls.length, 8);
  await time.advance(1);
  assert.equal(calls.length, 9);
  await time.advance(120_000);
  assert.equal(calls.length, 15);
  assert.equal(time.count(), 0);
  sync.stop();
});
