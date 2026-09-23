import assert from "node:assert/strict";
import test from "node:test";

import {
  createVerification,
  normalizeAdminVerificationStatus,
  updateVerification,
  uploadVerificationCSV,
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

test("admin status normalization supports fraud alias and verified default", () => {
  assert.equal(normalizeAdminVerificationStatus(undefined), "verified");
  assert.equal(normalizeAdminVerificationStatus(""), "verified");
  assert.equal(normalizeAdminVerificationStatus(" VERIFIED "), "verified");
  assert.equal(normalizeAdminVerificationStatus("fraud"), "fraudulent");
  assert.equal(normalizeAdminVerificationStatus("Fraudulent"), "fraudulent");
  assert.throws(
    () => normalizeAdminVerificationStatus("pending"),
    /verified.*fraudulent/
  );
});

test("manual creation defaults status and stores fraud alias canonically", async () => {
  const originalCreate = Verification.create;
  const createdPayloads = [];
  Verification.create = async (payload) => {
    createdPayloads.push(payload);
    return { _id: `record-${createdPayloads.length}`, ...payload };
  };

  try {
    await callController(createVerification, {
      body: { email: "safe@example.com" },
    });
    await callController(createVerification, {
      body: { website: "scam.example", status: "fraud" },
    });

    assert.equal(createdPayloads[0].status, "verified");
    assert.equal(createdPayloads[1].status, "fraudulent");
  } finally {
    Verification.create = originalCreate;
  }
});

test("existing verification status can be updated to fraudulent", async () => {
  const originalFindById = Verification.findById;
  let saved = false;
  const record = {
    _id: "verification-1",
    status: "verified",
    async save() {
      saved = true;
    },
  };
  Verification.findById = async () => record;

  try {
    const response = await callController(updateVerification, {
      params: { id: "verification-1" },
      body: { status: "fraudulent" },
    });

    assert.equal(saved, true);
    assert.equal(record.status, "fraudulent");
    assert.equal(response.statusCode, 200);
  } finally {
    Verification.findById = originalFindById;
  }
});

test("CSV status column is optional and blank values default to verified", async () => {
  const originalInsertMany = Verification.insertMany;
  let insertedRecords;
  Verification.insertMany = async (records) => {
    insertedRecords = records;
    return records;
  };

  const csv = [
    "email,phone,account,website,status",
    "safe@example.com,,,,verified",
    "scam@example.com,,,,fraud",
    "default@example.com,,,,",
  ].join("\n");

  try {
    const response = await callController(uploadVerificationCSV, {
      file: { buffer: Buffer.from(csv) },
    });

    assert.deepEqual(
      insertedRecords.map((record) => record.status),
      ["verified", "fraudulent", "verified"]
    );
    assert.equal(response.statusCode, 201);
    assert.equal(response.body.data.count, 3);
  } finally {
    Verification.insertMany = originalInsertMany;
  }
});

test("CSV without a status column keeps backward-compatible verified default", async () => {
  const originalInsertMany = Verification.insertMany;
  let insertedRecords;
  Verification.insertMany = async (records) => {
    insertedRecords = records;
    return records;
  };

  try {
    await callController(uploadVerificationCSV, {
      file: {
        buffer: Buffer.from(
          "email,phone,account,website\nlegacy@example.com,,,"
        ),
      },
    });

    assert.equal(insertedRecords[0].status, "verified");
  } finally {
    Verification.insertMany = originalInsertMany;
  }
});

test("CSV import rejects unsupported statuses with the row number", async () => {
  const originalInsertMany = Verification.insertMany;
  let insertCalled = false;
  Verification.insertMany = async () => {
    insertCalled = true;
    return [];
  };

  try {
    await assert.rejects(
      callController(uploadVerificationCSV, {
        file: {
          buffer: Buffer.from(
            "email,phone,account,website,status\nuser@example.com,,,,pending"
          ),
        },
      }),
      (error) =>
        error.statusCode === 400 &&
        error.message.includes("CSV row 2") &&
        error.message.includes("fraudulent")
    );
    assert.equal(insertCalled, false);
  } finally {
    Verification.insertMany = originalInsertMany;
  }
});
