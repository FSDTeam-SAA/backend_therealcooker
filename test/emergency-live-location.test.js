import assert from "node:assert/strict";
import test from "node:test";

import {
  getEmergencyLocation,
  updateEmergencyLocation,
} from "../controller/account.controller.js";
import { EmergencySession } from "../model/emergencySession.model.js";
import { Guardian } from "../model/guardian.model.js";
import { Notification } from "../model/notification.model.js";
import { User } from "../model/user.model.js";

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

test("active emergency location updates the session and stored user location", async () => {
  const originals = {
    findSession: EmergencySession.findOne,
    findGuardians: Guardian.find,
    updateNotifications: Notification.updateMany,
    updateUser: User.findByIdAndUpdate,
  };
  let sessionSaved = false;
  let storedUserLocation;
  const session = {
    _id: "session-1",
    lastKnownLocation: null,
    async save() {
      sessionSaved = true;
    },
  };

  EmergencySession.findOne = async () => session;
  Guardian.find = async () => [];
  Notification.updateMany = async () => ({ modifiedCount: 1 });
  User.findByIdAndUpdate = async (_id, update) => {
    storedUserLocation = update.$set.location;
  };

  try {
    const response = await callController(updateEmergencyLocation, {
      user: { _id: "owner-1" },
      body: {
        alertType: "emergency",
        sessionId: "session-1",
        lastKnownLocation: { latitude: 23.8103, longitude: 90.4125 },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(sessionSaved, true);
    assert.deepEqual(session.lastKnownLocation, {
      latitude: 23.8103,
      longitude: 90.4125,
    });
    assert.deepEqual(storedUserLocation, session.lastKnownLocation);
  } finally {
    EmergencySession.findOne = originals.findSession;
    Guardian.find = originals.findGuardians;
    Notification.updateMany = originals.updateNotifications;
    User.findByIdAndUpdate = originals.updateUser;
  }
});

test("guardian alert location updates only an active matching share", async () => {
  const originals = {
    findNotifications: Notification.find,
    updateNotifications: Notification.updateMany,
    updateUser: User.findByIdAndUpdate,
  };
  let notificationUpdate;

  Notification.find = () => ({
    select: async () => [{ recipient: "guardian-1" }],
  });
  Notification.updateMany = async (_filter, update) => {
    notificationUpdate = update;
  };
  User.findByIdAndUpdate = async () => null;

  try {
    const response = await callController(updateEmergencyLocation, {
      user: { _id: "owner-1" },
      body: {
        alertType: "guardian_alert",
        liveLocationShareId: "share-1",
        lastKnownLocation: { latitude: 51.5072, longitude: -0.1276 },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      notificationUpdate.$set["data.lastKnownLocation"],
      { latitude: 51.5072, longitude: -0.1276 }
    );
    assert.equal(response.body.data.liveLocationShareId, "share-1");
  } finally {
    Notification.find = originals.findNotifications;
    Notification.updateMany = originals.updateNotifications;
    User.findByIdAndUpdate = originals.updateUser;
  }
});

test("live location rejects out-of-range coordinates", async () => {
  await assert.rejects(
    callController(updateEmergencyLocation, {
      user: { _id: "owner-1" },
      body: {
        alertType: "emergency",
        lastKnownLocation: { latitude: 123, longitude: 90 },
      },
    }),
    (error) =>
      error.statusCode === 400 &&
      error.message === "A valid latitude and longitude are required"
  );
});

test("guardian can fetch the newest stored location for an active share", async () => {
  const originalFindNotification = Notification.findOne;
  Notification.findOne = async () => ({
    sender: "owner-1",
    data: {
      user: { id: "owner-1" },
      lastKnownLocation: { latitude: 40.7128, longitude: -74.006 },
      lastKnownLocationUpdatedAt: new Date("2026-09-23T08:00:00.000Z"),
    },
    updatedAt: new Date("2026-09-23T07:59:00.000Z"),
  });

  try {
    const response = await callController(getEmergencyLocation, {
      user: { _id: "guardian-1" },
      query: { liveLocationShareId: "share-1" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data.userId, "owner-1");
    assert.equal(response.body.data.liveLocationShareId, "share-1");
    assert.deepEqual(response.body.data.lastKnownLocation, {
      latitude: 40.7128,
      longitude: -74.006,
    });
  } finally {
    Notification.findOne = originalFindNotification;
  }
});
