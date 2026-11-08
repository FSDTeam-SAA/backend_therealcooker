import test from "node:test";
import assert from "node:assert/strict";
import { decide, voteOutcome, tally, REQUIRED_VOTES, REVIEW_ACTIONS } from "../utils/communityVotes.js";
import { reviewFeedbackDecision, submitFeedback } from "../controller/verification-feedback.controller.js";
import { routePermission, can } from "../utils/adminPermissions.js";

const counts = (legitimate, suspicious, not_sure) => ({ legitimate, suspicious, not_sure, total: legitimate + suspicious + not_sure });

test("the leading verdict needs strictly more votes than each other one", () => {
  assert.equal(voteOutcome(counts(2, 5, 1)), "suspicious");
  assert.equal(voteOutcome(counts(3, 2, 0)), "legitimate");
  assert.equal(voteOutcome(counts(3, 3, 0)), "tie");
  assert.equal(voteOutcome(counts(2, 1, 5)), "not_sure");
  assert.equal(voteOutcome(counts(3, 1, 3)), "tie", "a verdict tied with Not sure is not a lead");
  assert.equal(voteOutcome(counts(0, 0, 0)), "none");
});

const open = outcome => ({ outcome, status: "collecting", verdict: null, reason: null });
const verdict = outcome => ({ outcome, status: "resolved", verdict: outcome, reason: null });
const review = (outcome, reason) => ({ outcome, status: "needs_review", verdict: null, reason });

test("the consensus needs exactly 30 unique users", () => {
  assert.equal(REQUIRED_VOTES, 30);
});

test("nothing is decided before the 30th vote, however one-sided the votes are", () => {
  assert.deepEqual(decide(counts(0, 1, 0), null), open("suspicious"), "a first Suspicious vote decides nothing");
  assert.deepEqual(decide(counts(2, 2, 1), null), open("tie"), "five mixed votes decide nothing");
  assert.deepEqual(decide(counts(29, 0, 0), null), open("legitimate"), "29 identical votes decide nothing");
  assert.deepEqual(decide(counts(0, 29, 0), null), open("suspicious"));
  assert.deepEqual(decide(counts(0, 0, 29), null), open("not_sure"), "Not sure leading early does not go to review");
  assert.deepEqual(decide(counts(14, 15, 0), null), open("suspicious"));
});

test("at 30 votes the unique leader decides: Legitimate verifies, Suspicious flags, anything else goes to review", () => {
  const table = [
    [counts(20, 7, 3), verdict("legitimate")],
    [counts(5, 22, 3), verdict("suspicious")],
    [counts(5, 5, 20), review("not_sure", "not_sure_leads")],
    [counts(8, 2, 20), review("not_sure", "not_sure_leads")],
    [counts(2, 8, 20), review("not_sure", "not_sure_leads")],
    [counts(15, 15, 0), review("tie", "tie")],
    [counts(10, 10, 10), review("tie", "tie")],
    [counts(12, 11, 7), verdict("legitimate")],
    [counts(11, 12, 7), verdict("suspicious")],
    [counts(12, 6, 12), review("tie", "tie")],
    [counts(6, 12, 12), review("tie", "tie")],
    [counts(30, 0, 0), verdict("legitimate")],
    [counts(0, 0, 30), review("not_sure", "not_sure_leads")],
  ];
  for (const [votes, expected] of table) assert.deepEqual(decide(votes, null), expected, JSON.stringify(votes));
});

test("the unique leader wins without a majority", () => {
  assert.equal(decide(counts(11, 10, 9), null).verdict, "legitimate", "11 of 30 is enough when it leads alone");
  assert.equal(decide(counts(10, 11, 9), null).verdict, "suspicious");
});

test("votes never change an admin decision, before or after 30 votes", () => {
  const admin = { verdict: "legitimate", by: "admin" };
  for (const votes of [counts(0, 1, 0), counts(0, 30, 0), counts(0, 0, 30), counts(15, 15, 0)]) {
    assert.deepEqual(decide(votes, admin), { outcome: voteOutcome(votes), status: "resolved", verdict: null, reason: null });
  }
});

test("the required number can be passed explicitly", () => {
  assert.deepEqual(decide(counts(0, 2, 0), null, 3), open("suspicious"));
  assert.equal(decide(counts(0, 3, 0), null, 3).verdict, "suspicious");
});

test("tally fills in verdicts nobody chose", () => {
  assert.deepEqual(tally([{ _id: "suspicious", count: 2 }]), counts(0, 2, 0));
});

const call = (handler, req) => new Promise((resolve, reject) => handler({ params: {}, query: {}, ...req }, { status() { return this; }, json: resolve }, reject));
test("requests are validated before anything is stored", async () => {
  const user = { _id: "507f1f77bcf86cd799439011" };
  await assert.rejects(call(submitFeedback, { user, body: { type: "fax", value: "123", verdict: "legitimate" } }), /Type must be/);
  await assert.rejects(call(submitFeedback, { user, body: { type: "phone", value: "+44 7700 900482", verdict: "maybe" } }), /Verdict must be/);
  await assert.rejects(call(submitFeedback, { user, body: { type: "phone", value: "12", verdict: "legitimate" } }), /valid phone/);
  const id = "507f1f77bcf86cd799439012";
  await assert.rejects(call(reviewFeedbackDecision, { user, params: { id }, body: { action: "toString" } }), /Action must be/);
  await assert.rejects(call(reviewFeedbackDecision, { user, params: { id }, body: { action: "verify" } }), /reason/);
  await assert.rejects(call(reviewFeedbackDecision, { user, params: { id: "nope" }, body: { action: "hold" } }), /Invalid ID/);
  await assert.rejects(call(reviewFeedbackDecision, { user, params: { id }, body: { action: "collect" } }), /Action must be/);
  assert.deepEqual(Object.keys(REVIEW_ACTIONS), ["verify", "flag", "hold"]);
});

test("reading feedback needs verification:read and deciding needs verification:write", () => {
  const request = method => ({ method, baseUrl: "/api/v1/admin", path: "/verification-feedback/abc" });
  assert.equal(routePermission(request("GET")), "verification:read");
  assert.equal(routePermission(request("PATCH")), "verification:write");
  assert.equal(can({ role: "admin", adminRole: "operations" }, "verification:write"), false);
  assert.equal(can({ role: "admin", adminRole: "superadmin" }, "verification:write"), true);
});
