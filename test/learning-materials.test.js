import assert from "node:assert/strict";
import test from "node:test";

import {
  getPublishedLearnings,
  toPublicLearningDto,
} from "../controller/learning.controller.js";
import { Learning } from "../model/learning.model.js";

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

const request = {
  protocol: "https",
  get: (name) => (name === "host" ? "api.moneykee.example" : ""),
};

test("public learning DTO exposes a stable mobile shape and absolute image URL", () => {
  const dto = toPublicLearningDto(
    {
      _id: "learning-1",
      title: "Recognising phishing links",
      description: "Check the sender and destination before opening a link.",
      image: { url: "/uploads/phishing.jpg" },
      author: { name: "MoneyKee" },
      createdAt: new Date("2026-09-20T10:00:00Z"),
      updatedAt: new Date("2026-09-21T10:00:00Z"),
    },
    request
  );

  assert.equal(dto.id, "learning-1");
  assert.equal(dto.image_url, "https://api.moneykee.example/uploads/phishing.jpg");
  assert.equal(dto.content, dto.summary);
  assert.equal(dto.author, "MoneyKee");
});

test("public learning feed only requests published records newest first", async () => {
  const originalCountDocuments = Learning.countDocuments;
  const originalFind = Learning.find;
  let capturedCountFilter;
  let capturedFindFilter;
  let capturedSort;

  Learning.countDocuments = async (filter) => {
    capturedCountFilter = filter;
    return 1;
  };
  Learning.find = (filter) => {
    capturedFindFilter = filter;
    const query = {
      sort(value) {
        capturedSort = value;
        return query;
      },
      skip() {
        return query;
      },
      limit() {
        return query;
      },
      async populate() {
        return [
          {
            _id: "learning-1",
            title: "Stay safe",
            description: "Useful content",
            image: { url: "https://cdn.example/learning.jpg" },
            createdAt: new Date("2026-09-20T10:00:00Z"),
          },
        ];
      },
    };
    return query;
  };

  try {
    const response = await callController(getPublishedLearnings, {
      ...request,
      query: {},
    });

    assert.deepEqual(capturedCountFilter, { isPublished: true });
    assert.deepEqual(capturedFindFilter, { isPublished: true });
    assert.deepEqual(capturedSort, { createdAt: -1 });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.pagination.total, 1);
  } finally {
    Learning.countDocuments = originalCountDocuments;
    Learning.find = originalFind;
  }
});
