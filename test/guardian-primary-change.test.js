import assert from "node:assert/strict";
import test from "node:test";

import { cancelPrimaryGuardianChange } from "../controller/guardian.controller.js";
import { Notification } from "../model/notification.model.js";
import { PrimaryGuardianChangeRequest } from "../model/primaryGuardianChangeRequest.model.js";

const resolvedQuery = (value) => {
  const query = {
    populate() {
      return query;
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
  return query;
};

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

test("owner can cancel a pending Primary Guardian change", async () => {
  const originalFindOneAndUpdate =
    PrimaryGuardianChangeRequest.findOneAndUpdate;
  const originalUpdateMany = Notification.updateMany;
  let requestFilter;
  let requestUpdate;
  let notificationUpdate;

  PrimaryGuardianChangeRequest.findOneAndUpdate = (filter, update) => {
    requestFilter = filter;
    requestUpdate = update;
    return resolvedQuery({
      _id: "change-1",
      currentPrimaryGuardianUser: null,
      proposedPrimaryGuardian: {
        _id: "guardian-secondary",
        name: "Jordan",
      },
    });
  };
  Notification.updateMany = async (_filter, update) => {
    notificationUpdate = update;
  };

  try {
    const response = await callController(cancelPrimaryGuardianChange, {
      params: { id: "guardian-secondary" },
      user: { _id: "owner-1", name: "Alex" },
    });

    assert.deepEqual(requestFilter, {
      user: "owner-1",
      proposedPrimaryGuardian: "guardian-secondary",
      status: "pending",
    });
    assert.equal(requestUpdate.$set.status, "cancelled");
    assert.ok(requestUpdate.$set.resolvedAt instanceof Date);
    assert.equal(notificationUpdate.$set["data.decision"], "cancelled");
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.status, "cancelled");
  } finally {
    PrimaryGuardianChangeRequest.findOneAndUpdate = originalFindOneAndUpdate;
    Notification.updateMany = originalUpdateMany;
  }
});

test("cannot cancel a Primary Guardian change that is no longer pending", async () => {
  const originalFindOneAndUpdate =
    PrimaryGuardianChangeRequest.findOneAndUpdate;
  PrimaryGuardianChangeRequest.findOneAndUpdate = () => resolvedQuery(null);

  try {
    await assert.rejects(
      callController(cancelPrimaryGuardianChange, {
        params: { id: "guardian-secondary" },
        user: { _id: "owner-1", name: "Alex" },
      }),
      (error) =>
        error.statusCode === 409 &&
        error.message ===
          "No pending Primary Guardian change was found to cancel"
    );
  } finally {
    PrimaryGuardianChangeRequest.findOneAndUpdate = originalFindOneAndUpdate;
  }
});
