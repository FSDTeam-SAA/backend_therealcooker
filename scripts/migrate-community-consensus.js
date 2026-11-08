import "dotenv/config";
import mongoose from "mongoose";
import { VerificationFeedback } from "../model/verificationFeedback.model.js";
import { inTransaction, reconcileFeedback, REQUIRED_VOTES } from "../utils/communityVotes.js";

// Moves community feedback recorded under the old rules (one clear vote decided a contact) onto the
// REQUIRED_VOTES-user consensus:
// - a community verdict or review reached with fewer than REQUIRED_VOTES votes is withdrawn, its
//   community verifier record removed, and the contact collects votes again (existing votes count);
// - a contact that already has REQUIRED_VOTES votes is closed on its earliest REQUIRED_VOTES votes;
// - admin decisions, and verifier records entered by admins, are never touched.
// Each contact is updated in its own transaction and the script can be run again safely.
// Dry run by default; pass --apply to write.
const apply = process.argv.includes("--apply");
const results = { reset: 0, closed: 0, unchanged: 0, failed: 0 };

// Runs the reconciliation and rolls it back, so a dry run reports exactly what --apply would do.
async function dryRun(id) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    return await reconcileFeedback(id, session);
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
}

try {
  await mongoose.connect(process.env.MONGO_URI);
  for await (const { _id, type, value } of VerificationFeedback.find({ "resolution.by": { $ne: "admin" } }).select("_id type value").lean().cursor()) {
    try {
      const result = apply ? await inTransaction(session => reconcileFeedback(_id, session)) : await dryRun(_id);
      results[result] += 1;
      if (result !== "unchanged") console.log(`${result}: ${type} ${value}`);
    } catch (error) {
      results.failed += 1;
      console.error(`failed: ${type} ${value} (${_id}): ${error.message}`);
    }
  }
  console.log(`${apply ? "Applied" : "Dry run"} (${REQUIRED_VOTES} votes required): ${results.reset} back to collecting, ${results.closed} closed on ${REQUIRED_VOTES} votes, ${results.unchanged} unchanged, ${results.failed} failed.`);
  if (!apply) console.log("Nothing was written. Use --apply to update the records.");
  if (results.failed) process.exitCode = 1;
} finally { await mongoose.disconnect(); }
