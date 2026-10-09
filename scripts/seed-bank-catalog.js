import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { Bank } from "../model/bank.model.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";

// Imports the ten bank names and the exact logo files previously bundled in Flutter.
// Safe to rerun: existing catalog entries are left as the admin last edited them.
export const originalBanks = [
  ["First National Bank (FNB)", "fnb.png"],
  ["Absa Bank", "absa.png"],
  ["Nedbank", "nedbank.png"],
  ["Capitec Bank", "capitec.png"],
  ["Investec Bank", "investec.png"],
  ["African Bank", "african_bank.png"],
  ["Bidvest Bank", "bidvest.png"],
  ["Sasfin Bank", "sasfin.png"],
  ["TymeBank", "tymebank.png"],
  ["Discovery Bank", "discovery.png"],
];

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error("Cloudinary credentials are required");
  }
  const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../flutter_therealcooker/assets/images/banks");
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    for (const [index, [name, file]] of originalBanks.entries()) {
      const nameKey = name.toLocaleLowerCase("en");
      if (await Bank.exists({ nameKey })) { console.log(`Already present: ${name}`); continue; }
      const bytes = await readFile(path.join(sourceDir, file));
      const uploaded = await uploadOnCloudinary(bytes, { folder: "moneykee/banks", resource_type: "image" });
      await Bank.create({ name, nameKey, logo: { url: uploaded.secure_url, publicId: uploaded.public_id }, sortOrder: index + 1, isActive: true });
      console.log(`Imported: ${name}`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Bank import failed: ${error.message}`); process.exitCode = 1; });
}
