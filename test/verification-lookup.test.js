import assert from "node:assert/strict";
import test from "node:test";

import {
  checkVerification,
  detectVerificationType,
  normalizeVerificationValue,
} from "../controller/verification.controller.js";
import { Verification } from "../model/verification.model.js";
import { VerificationFeedback, VerificationVote } from "../model/verificationFeedback.model.js";

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

const withLookupRecord = async (record, callback, feedback = null, vote = null) => {
  const originalFindOne = Verification.findOne;
  const originalFeedback = VerificationFeedback.findOne;
  const originalVote = VerificationVote.findOne;
  const query = (result) => () => ({ select() { return this; }, lean: async () => result });
  VerificationFeedback.findOne = query(feedback);
  VerificationVote.findOne = query(vote);
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
    VerificationFeedback.findOne = originalFeedback;
    VerificationVote.findOne = originalVote;
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

test("a contact still collecting votes is not found and takes feedback", async () => {
  await withLookupRecord(null, async () => {
    const response = await callController(checkVerification, {
      body: { value: "www.moneykey.com", type: "website" },
      query: {},
      user: { _id: "507f1f77bcf86cd799439011" },
    });

    assert.equal(response.body.status, "not_found");
    assert.match(response.body.message, /No record found/);
    assert.deepEqual(response.body.data.feedback, { yourVote: "suspicious", status: "collecting", acceptingVotes: true });
  }, { _id: "feedback-1", status: "collecting" }, { verdict: "suspicious" });
});

test("a contact whose closed vote went to an admin is reported as under review and takes no votes", async () => {
  await withLookupRecord(null, async () => {
    const response = await callController(checkVerification, {
      body: { value: "support@example.com", type: "email" },
      query: {},
    });

    assert.equal(response.body.status, "not_found");
    assert.match(response.body.message, /reviewing/);
    assert.deepEqual(response.body.data.feedback, { yourVote: null, status: "needs_review", acceptingVotes: false });
  }, { _id: "feedback-2", status: "needs_review" });
});
