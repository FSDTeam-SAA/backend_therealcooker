// End-to-end checks of the 30-user community consensus against a real MongoDB replica set
// (transactions need one). Skipped unless COMMUNITY_VOTES_TEST_URI points at a disposable database,
// e.g. COMMUNITY_VOTES_TEST_URI="mongodb://127.0.0.1:27017/consensus_test?replicaSet=rs0".
// The database is dropped before every test.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { Verification } from "../model/verification.model.js";
import { VerificationFeedback, VerificationVote } from "../model/verificationFeedback.model.js";
import { checkVerification } from "../controller/verification.controller.js";
import { submitFeedback, reviewFeedbackDecision } from "../controller/verification-feedback.controller.js";
import { inTransaction, reconcileFeedback, REQUIRED_VOTES } from "../utils/communityVotes.js";

const uri = process.env.COMMUNITY_VOTES_TEST_URI;
const skip = !uri && "set COMMUNITY_VOTES_TEST_URI to a disposable replica-set database";

const call = (handler, req) => new Promise((resolve, reject) => {
  const res = { status() { return res; }, json: resolve };
  handler({ params: {}, query: {}, body: {}, ...req }, res, reject);
});
const newUser = () => ({ _id: new mongoose.Types.ObjectId() });
const lookup = (type, value, user) => call(checkVerification, { body: { type, value }, user });
const vote = (type, value, verdict, user = newUser()) => call(submitFeedback, { body: { type, value, verdict }, user });
const decideAs = (id, action, reason) => call(reviewFeedbackDecision, { params: { id: String(id) }, body: { action, reason }, user: newUser() });
const settle = promises => Promise.allSettled(promises).then(results => ({
  accepted: results.filter(result => result.status === "fulfilled").length,
  rejected: results.filter(result => result.status === "rejected").map(result => result.reason),
}));
// Casts the given numbers of Legitimate, Suspicious and Not sure votes, one new user each, in turn.
async function castVotes(type, value, legitimate, suspicious, notSure) {
  const verdicts = [...Array(legitimate).fill("legitimate"), ...Array(suspicious).fill("suspicious"), ...Array(notSure).fill("not_sure")];
  for (const verdict of verdicts) await vote(type, value, verdict);
}
const feedbackFor = (type, value) => VerificationFeedback.findOne({ type, value }).lean();

test.describe("30-user community consensus", { skip }, () => {
  test.before(async () => { await mongoose.connect(uri); });
  test.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  test.beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await Promise.all([Verification, VerificationFeedback, VerificationVote].map(model => model.syncIndexes()));
  });

  test("an unknown contact is not found and invites feedback", async () => {
    const response = await lookup("website", "www.moneykey.com", newUser());
    assert.equal(response.status, "not_found");
    assert.deepEqual(response.data.feedback, { yourVote: null, status: "collecting", acceptingVotes: true });
  });

  test("a first Suspicious vote decides nothing and the next user still gets the feedback option", async () => {
    const first = newUser();
    const stored = await vote("website", "www.moneykey.com", "suspicious", first);
    assert.equal(stored.data.status, "collecting");
    assert.equal(await Verification.countDocuments(), 0, "nothing is written to the verifier");
    const second = await lookup("website", "https://MoneyKey.com/", newUser());
    assert.equal(second.status, "not_found");
    assert.deepEqual(second.data.feedback, { yourVote: null, status: "collecting", acceptingVotes: true });
    const again = await lookup("website", "moneykey.com", first);
    assert.equal(again.status, "not_found", "the voter does not see their own vote as a result");
    assert.equal(again.data.feedback.yourVote, "suspicious");
  });

  test("5 mixed votes and then 29 identical votes still leave the contact collecting", async () => {
    await castVotes("website", "moneykey.com", 2, 2, 1);
    assert.equal((await feedbackFor("website", "moneykey.com")).status, "collecting");
    await castVotes("email", "support@example.com", 29, 0, 0);
    const feedback = await feedbackFor("email", "support@example.com");
    assert.equal(feedback.status, "collecting");
    assert.equal(feedback.counts.total, 29);
    assert.equal(await Verification.countDocuments(), 0);
    assert.equal((await lookup("email", "Support@Example.com")).status, "not_found");
  });

  test("the 30th vote with Legitimate leading verifies the contact and closes voting", async () => {
    await castVotes("website", "moneykey.com", 19, 7, 3);
    assert.equal((await feedbackFor("website", "moneykey.com")).status, "collecting");
    const last = await vote("website", "www.moneykey.com", "legitimate");
    assert.equal(last.data.status, "resolved");
    const feedback = await feedbackFor("website", "moneykey.com");
    assert.deepEqual(feedback.counts, { legitimate: 20, suspicious: 7, not_sure: 3, total: 30 });
    assert.equal(feedback.resolution.verdict, "legitimate");
    assert.equal(feedback.resolution.by, "community");
    assert.ok(feedback.closedAt);
    assert.deepEqual(feedback.history.map(entry => entry.action), ["community_verdict"], "evaluated exactly once");
    const response = await lookup("website", "moneykey.com", newUser());
    assert.equal(response.status, "verified");
    assert.equal(response.data.details.source, "community");
    await assert.rejects(vote("website", "moneykey.com", "suspicious"), error => error.statusCode === 409);
    assert.equal(await VerificationVote.countDocuments(), 30);
  });

  test("the 30th vote with Suspicious leading flags the contact", async () => {
    await castVotes("phone", "+1 234 567 890", 5, 22, 3);
    const feedback = await feedbackFor("phone", "1234567890");
    assert.equal(feedback.status, "resolved");
    assert.equal(feedback.resolution.verdict, "suspicious");
    assert.equal((await lookup("phone", "1234567890")).status, "fraudulent");
  });

  for (const [label, votes] of [["Not sure leads (5/5/20)", [5, 5, 20]], ["Not sure leads (8/2/20)", [8, 2, 20]], ["Legitimate and Suspicious tie", [15, 15, 0]], ["all three tie", [10, 10, 10]]]) {
    test(`${label}: the closed vote goes to admin review and takes no more votes`, async () => {
      await castVotes("account", "ACC-0001-22", ...votes);
      const feedback = await feedbackFor("account", "acc000122");
      assert.equal(feedback.status, "needs_review");
      assert.equal(feedback.reviewReason, votes[2] === 20 ? "not_sure_leads" : "tie");
      assert.equal(feedback.resolution?.verdict, undefined);
      assert.equal(await Verification.countDocuments(), 0, "nothing is classified automatically");
      const response = await lookup("account", "acc 0001 22", newUser());
      assert.equal(response.status, "not_found");
      assert.match(response.message, /reviewing/);
      assert.deepEqual(response.data.feedback, { yourVote: null, status: "needs_review", acceptingVotes: false });
      await assert.rejects(vote("account", "acc000122", "legitimate"), error => error.statusCode === 409 && /closed/.test(error.message));
    });
  }

  test("repeated searches add no votes and a second vote from the same user is rejected", async () => {
    const user = newUser();
    for (let index = 0; index < 5; index += 1) await lookup("website", "moneykey.com", user);
    assert.equal(await VerificationVote.countDocuments(), 0);
    await vote("website", "moneykey.com", "suspicious", user);
    for (let index = 0; index < 3; index += 1) await lookup("website", "moneykey.com", user);
    await assert.rejects(vote("website", "www.MONEYKEY.com/", "legitimate", user), error => error.statusCode === 409 && /already/.test(error.message));
    const feedback = await feedbackFor("website", "moneykey.com");
    assert.equal(feedback.counts.total, 1);
    assert.equal(feedback.counts.suspicious, 1);
  });

  test("simultaneous duplicate requests from one user store one vote", async () => {
    const user = newUser();
    const { accepted, rejected } = await settle(Array.from({ length: 8 }, () => vote("email", "dup@example.com", "legitimate", user)));
    assert.equal(accepted, 1);
    assert.ok(rejected.every(error => error.statusCode === 409), rejected.map(error => error.message).join("; "));
    assert.equal((await feedbackFor("email", "dup@example.com")).counts.total, 1);
  });

  test("simultaneous votes near the threshold: exactly 30 are counted and the vote closes once", async () => {
    await castVotes("website", "moneykey.com", 14, 13, 1);
    const { accepted, rejected } = await settle(Array.from({ length: 10 }, () => vote("website", "moneykey.com", "legitimate")));
    assert.equal(accepted, 2);
    assert.equal(rejected.length, 8);
    assert.ok(rejected.every(error => error.statusCode === 409 && /closed/.test(error.message)), rejected.map(error => error.message).join("; "));
    const feedback = await feedbackFor("website", "moneykey.com");
    assert.deepEqual(feedback.counts, { legitimate: 16, suspicious: 13, not_sure: 1, total: 30 });
    assert.equal(feedback.status, "resolved");
    assert.equal(feedback.history.length, 1, "evaluated exactly once");
    assert.equal(await VerificationVote.countDocuments(), 30);
    assert.equal(await Verification.countDocuments(), 1);
  });

  test("40 users voting at once on a new contact: exactly 30 votes are taken", async () => {
    const { accepted } = await settle(Array.from({ length: 40 }, (_, index) => vote("email", "rush@example.com", index % 2 ? "suspicious" : "not_sure")));
    assert.equal(accepted, REQUIRED_VOTES);
    assert.equal(await VerificationFeedback.countDocuments(), 1, "one record per contact");
    const feedback = await feedbackFor("email", "rush@example.com");
    assert.equal(feedback.counts.total, 30);
    assert.equal(await VerificationVote.countDocuments(), 30);
    assert.equal(feedback.history.length, 1);
  });

  test("each contact keeps its own count, even with the same text under another type", async () => {
    await castVotes("account", "12345678", 0, 30, 0);
    await castVotes("phone", "12345678", 3, 0, 0);
    await castVotes("email", "support@example.com", 1, 0, 0);
    assert.equal((await feedbackFor("account", "12345678")).status, "resolved");
    const phone = await feedbackFor("phone", "12345678");
    assert.equal(phone.status, "collecting");
    assert.equal(phone.counts.total, 3);
    assert.equal((await feedbackFor("email", "support@example.com")).counts.total, 1);
    assert.equal((await lookup("account", "1234-5678")).status, "fraudulent");
    assert.equal((await lookup("phone", "12345678")).status, "not_found");
  });

  test("an admin decision on a reviewed contact is final and later votes cannot change it", async () => {
    await castVotes("website", "moneykey.com", 5, 5, 20);
    const { _id } = await feedbackFor("website", "moneykey.com");
    await decideAs(_id, "hold", "Asking the bank");
    let feedback = await feedbackFor("website", "moneykey.com");
    assert.equal(feedback.status, "needs_review", "hold keeps it pending");
    assert.equal(feedback.history.at(-1).action, "kept_pending");
    await decideAs(_id, "flag", "Confirmed scam");
    feedback = await feedbackFor("website", "moneykey.com");
    assert.equal(feedback.status, "resolved");
    assert.equal(feedback.resolution.by, "admin");
    assert.equal((await lookup("website", "moneykey.com")).status, "fraudulent");
    await assert.rejects(vote("website", "moneykey.com", "legitimate"), error => error.statusCode === 409);
    await assert.rejects(decideAs(_id, "hold"), error => error.statusCode === 409, "hold only applies while awaiting review");
    assert.equal(await inTransaction(session => reconcileFeedback(_id, session)), "unchanged", "the migration never touches admin decisions");
    assert.equal((await lookup("website", "moneykey.com")).status, "fraudulent");
  });

  test("an admin decision before 30 votes closes voting", async () => {
    await castVotes("email", "early@example.com", 2, 0, 0);
    const { _id } = await feedbackFor("email", "early@example.com");
    await decideAs(_id, "verify", "Known partner");
    await assert.rejects(vote("email", "early@example.com", "suspicious"), error => error.statusCode === 409);
    const feedback = await feedbackFor("email", "early@example.com");
    assert.equal(feedback.counts.total, 2);
    assert.equal((await lookup("email", "early@example.com")).status, "verified");
  });

  test("admin-entered verified and fraudulent records are unchanged and take no votes", async () => {
    await Verification.create([{ email: "good@example.com", status: "verified", source: "manual" }, { website: "https://bad.example.com/", status: "fraudulent", source: "csv" }]);
    const good = await lookup("email", "Good@Example.com");
    assert.equal(good.status, "verified");
    assert.equal(good.data.details.source, "moneykee");
    assert.equal((await lookup("website", "www.bad.example.com")).status, "fraudulent");
    await assert.rejects(vote("email", "good@example.com", "suspicious"), error => error.statusCode === 409 && /already in the verification database/.test(error.message));
    assert.equal(await VerificationFeedback.countDocuments(), 0);
  });

  test("the migration withdraws verdicts the old one-vote rule produced and closes records that already have 30 votes", async () => {
    const at = new Date("2026-10-01T00:00:00Z");
    // A contact one Suspicious vote decided under the old rules.
    const [legacyVerdict] = await Verification.create([{ website: "moneykey.com", status: "fraudulent", source: "community" }]);
    const decided = await VerificationFeedback.create({ type: "website", value: "moneykey.com", counts: { legitimate: 0, suspicious: 1, not_sure: 0, total: 1 }, outcome: "suspicious", status: "resolved", resolution: { verdict: "suspicious", by: "community", at }, verification: legacyVerdict._id, history: [{ action: "community_verdict", by: "community", counts: { legitimate: 0, suspicious: 1, not_sure: 0, total: 1 }, at }] });
    await VerificationVote.create({ feedback: decided._id, user: newUser()._id, verdict: "suspicious" });
    // A contact sent to review on two votes.
    const reviewing = await VerificationFeedback.create({ type: "email", value: "x@example.com", counts: { legitimate: 1, suspicious: 1, not_sure: 0, total: 2 }, outcome: "tie", status: "needs_review" });
    await VerificationVote.create([{ feedback: reviewing._id, user: newUser()._id, verdict: "legitimate" }, { feedback: reviewing._id, user: newUser()._id, verdict: "suspicious" }]);
    // A contact with 31 votes still collecting: closed on its earliest 30 (20 Legitimate, 10 Suspicious).
    const crowded = await VerificationFeedback.create({ type: "phone", value: "5550001111", status: "collecting" });
    const votes = Array.from({ length: 31 }, (_, index) => ({ feedback: crowded._id, user: newUser()._id, verdict: index < 20 ? "legitimate" : "suspicious", createdAt: new Date(at.getTime() + index * 1000) }));
    await VerificationVote.insertMany(votes);

    const run = id => inTransaction(session => reconcileFeedback(id, session));
    assert.equal(await run(decided._id), "reset");
    assert.equal(await Verification.exists({ _id: legacyVerdict._id }), null, "the one-vote verdict is removed");
    const reset = await VerificationFeedback.findById(decided._id).lean();
    assert.equal(reset.status, "collecting");
    assert.equal(reset.resolution, undefined);
    assert.equal(reset.history.at(-1).action, "consensus_reset");
    const response = await lookup("website", "moneykey.com", newUser());
    assert.equal(response.status, "not_found");
    assert.equal(response.data.feedback.acceptingVotes, true);

    assert.equal(await run(reviewing._id), "reset");
    assert.equal((await VerificationFeedback.findById(reviewing._id).lean()).status, "collecting");

    assert.equal(await run(crowded._id), "closed");
    const closed = await VerificationFeedback.findById(crowded._id).lean();
    assert.deepEqual(closed.counts, { legitimate: 20, suspicious: 10, not_sure: 0, total: 30 });
    assert.equal(closed.resolution.verdict, "legitimate");
    assert.equal((await lookup("phone", "555-000-1111")).status, "verified");

    for (const id of [decided._id, reviewing._id, crowded._id]) assert.equal(await run(id), "unchanged", "running it again changes nothing");
    // The reset contact now needs 30 users like any other; its old vote still counts.
    await castVotes("website", "moneykey.com", 0, 28, 0);
    assert.equal((await feedbackFor("website", "moneykey.com")).status, "collecting");
    await vote("website", "moneykey.com", "suspicious");
    assert.equal((await feedbackFor("website", "moneykey.com")).status, "resolved");
  });
});
