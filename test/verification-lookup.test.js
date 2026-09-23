import assert from "node:assert/strict";
import test from "node:test";

import {
  checkVerification,
  detectVerificationType,
  normalizeVerificationValue,
} from "../controller/verification.controller.js";
import { Verification } from "../model/verification.model.js";

const callController = (handler, req) =>
  new Promise((resolve, reject) => {
    let statusCode;
    const res = {
      status(value) {
        statusCode = value;
        return res;
      },
      json(body) {
        resolve({ statusCode, body });
        return res;
      },
    };
    handler(req, res, reject);
  });

const withLookupRecord = async (record, callback) => {
  const originalFindOne = Verification.findOne;
  let capturedFilter;
  Verification.findOne = (filter) => {
    capturedFilter = filter;
    return {
      sort() {
        return this;
      },
      async lean() {
        return record;
      },
    };
  };

  try {
    await callback(() => capturedFilter);
  } finally {
    Verification.findOne = originalFindOne;
  }
};

test("lookup normalization detects and canonicalizes supported values", () => {
  assert.equal(detectVerificationType("Person@Example.com"), "email");
  assert.equal(detectVerificationType("https://www.Example.com/path/"), "website");
  assert.equal(detectVerificationType("+44 (0) 1234 567890"), "phone");
  assert.equal(
    normalizeVerificationValue("https://www.Example.com/path/", "website"),
    "example.com/path"
  );
  assert.equal(normalizeVerificationValue("012-345-6789", "phone"), "0123456789");
});

test("public lookup returns a verified verdict", async () => {
  await withLookupRecord(
    {
      _id: "verification-1",
      email: "Person@Example.com",
      status: "trusted",
      createdAt: new Date("2026-09-20T10:00:00Z"),
    },
    async (getFilter) => {
      const response = await callController(checkVerification, {
        body: { value: " person@example.com ", type: "email" },
        query: {},
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.body.status, "verified");
      assert.equal(response.body.data.status, "verified");
      assert.equal(response.body.data.value, "person@example.com");
      assert.equal(getFilter().email.test("PERSON@EXAMPLE.COM"), true);
    }
  );
});

test("public lookup maps flagged records to fraudulent", async () => {
  await withLookupRecord(
    {
      _id: "verification-2",
      website: "https://example.com/",
      status: "flagged",
      createdAt: new Date(),
    },
    async () => {
      const response = await callController(checkVerification, {
        body: { value: "www.example.com", type: "website" },
        query: {},
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.body.status, "fraudulent");
      assert.match(response.body.message, /fraudulent/i);
    }
  );
});

test("public lookup returns a clean not_found verdict with HTTP 200", async () => {
  await withLookupRecord(null, async () => {
    const response = await callController(checkVerification, {
      body: { value: "0123456789", type: "phone" },
      query: {},
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, "not_found");
    assert.equal(response.body.data.details, null);
  });
});
