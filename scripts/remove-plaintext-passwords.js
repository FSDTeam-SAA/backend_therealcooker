import "dotenv/config";
import mongoose from "mongoose";

// Explicit --apply is required. Default mode only counts affected records.
try {
  await mongoose.connect(process.env.MONGO_URI);
  const users = mongoose.connection.collection("users");
  const affected = await users.countDocuments({ textPassword: { $exists: true } });
  console.log(`Users with legacy plaintext password field: ${affected}`);
  if (process.argv.includes("--apply")) {
    const result = await users.updateMany({ textPassword: { $exists: true } }, { $unset: { textPassword: "" } });
    console.log(`Removed legacy field from ${result.modifiedCount} users. Password hashes preserved.`);
  } else console.log("Dry run. Use --apply to remove the legacy field.");
} finally { await mongoose.disconnect(); }
