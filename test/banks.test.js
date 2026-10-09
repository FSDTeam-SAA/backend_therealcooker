import test from "node:test";
import assert from "node:assert/strict";
import { Bank } from "../model/bank.model.js";
import { listPublicBanks, createBank, updateBank } from "../controller/bank.controller.js";
import { routePermission, can } from "../utils/adminPermissions.js";

const call = (handler, extra = {}) => new Promise((resolve, reject) => {
  const res = { status(code) { this.code = code; return this; }, json(value) { resolve({ status: this.code, ...value }); } };
  handler({ params: { id: "507f1f77bcf86cd799439012" }, body: {}, ...extra }, res, reject);
});

test("bank catalog permissions permit operators to manage banks", () => {
  const req = { method: "POST", baseUrl: "/api/v1/admin", path: "/banks" };
  assert.equal(routePermission(req), "banks:write");
  assert.equal(can({ role: "admin", adminRole: "operations" }, "banks:write"), true);
  assert.equal(can({ role: "admin", adminRole: "support" }, "banks:write"), false);
});

test("public bank catalog only asks for active banks and logo URLs", async () => {
  const original = Bank.find;
  let filter; let projection;
  Bank.find = value => { filter = value; return { select(value) { projection = value; return this; }, sort() { return this; }, lean: async () => [{ _id: "bank1", name: "Example Bank", logo: { url: "https://example.test/logo.png" } }] }; };
  try {
    const response = await call(listPublicBanks);
    assert.deepEqual(filter, { isActive: true });
    assert.match(projection, /logo\.url/);
    assert.equal(response.data[0].name, "Example Bank");
  } finally { Bank.find = original; }
});

test("bank creation requires a logo and update rejects invalid status", async () => {
  await assert.rejects(call(createBank, { body: { name: "Example Bank" } }), /logo is required/i);
  const original = Bank.findById;
  Bank.findById = async () => ({ isActive: true });
  try {
    await assert.rejects(call(updateBank, { body: { isActive: "maybe" } }), /Invalid bank status/);
  } finally { Bank.findById = original; }
});
