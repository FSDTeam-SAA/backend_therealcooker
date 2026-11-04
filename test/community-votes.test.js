import test from "node:test";
import assert from "node:assert/strict";
import { decide, voteOutcome, tally, minimumVotes, REVIEW_ACTIONS } from "../utils/communityVotes.js";
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

test("clear Legitimate or Suspicious leads become verdicts; ties and Not sure go to review", () => {
  assert.deepEqual(decide(counts(2, 5, 1), null, 1), { outcome: "suspicious", status: "resolved", verdict: "suspicious" });
  assert.deepEqual(decide(counts(3, 2, 0), null, 1), { outcome: "legitimate", status: "resolved", verdict: "legitimate" });
  assert.deepEqual(decide(counts(3, 3, 0), null, 1), { outcome: "tie", status: "needs_review", verdict: null });
  assert.deepEqual(decide(counts(2, 1, 5), null, 1), { outcome: "not_sure", status: "needs_review", verdict: null });
});

test("unclear votes never replace an established verdict, and votes never change an admin decision", () => {
  const community = { verdict: "suspicious", by: "community" };
  assert.deepEqual(decide(counts(1, 1, 3), community, 1), { outcome: "not_sure", status: "needs_review", verdict: null });
  assert.deepEqual(decide(counts(2, 2, 0), community, 1), { outcome: "tie", status: "needs_review", verdict: null });
  assert.deepEqual(decide(counts(4, 1, 0), community, 1).verdict, "legitimate", "a clear new lead replaces a community verdict");
  const admin = { verdict: "legitimate", by: "admin" };
  for (const votes of [counts(0, 9, 0), counts(0, 0, 9), counts(2, 2, 0)]) assert.deepEqual(decide(votes, admin, 1), { outcome: voteOutcome(votes), status: "resolved", verdict: null });
});

test("a minimum vote count holds back a verdict until it is reached", () => {
  assert.deepEqual(decide(counts(0, 2, 0), null, 3), { outcome: "suspicious", status: "collecting", verdict: null });
  assert.equal(decide(counts(0, 3, 0), null, 3).verdict, "suspicious");
  const previous = process.env.COMMUNITY_VOTE_MIN_VOTES;
  try {
    delete process.env.COMMUNITY_VOTE_MIN_VOTES; assert.equal(minimumVotes(), 1);
    process.env.COMMUNITY_VOTE_MIN_VOTES = "5"; assert.equal(minimumVotes(), 5);
    process.env.COMMUNITY_VOTE_MIN_VOTES = "nonsense"; assert.equal(minimumVotes(), 1);
  } finally { previous === undefined ? delete process.env.COMMUNITY_VOTE_MIN_VOTES : process.env.COMMUNITY_VOTE_MIN_VOTES = previous; }
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
  await assert.rejects(call(reviewFeedbackDecision, { user, params: { id: "nope" }, body: { action: "collect" } }), /Invalid ID/);
  assert.deepEqual(Object.keys(REVIEW_ACTIONS), ["verify", "flag", "collect"]);
});

test("reading feedback needs verification:read and deciding needs verification:write", () => {
  const request = method => ({ method, baseUrl: "/api/v1/admin", path: "/verification-feedback/abc" });
  assert.equal(routePermission(request("GET")), "verification:read");
  assert.equal(routePermission(request("PATCH")), "verification:write");
  assert.equal(can({ role: "admin", adminRole: "operations" }, "verification:write"), false);
  assert.equal(can({ role: "admin", adminRole: "superadmin" }, "verification:write"), true);
});
