import mongoose, { Schema } from "mongoose";

const bankSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  nameKey: { type: String, required: true, unique: true },
  logo: { url: { type: String, required: true }, publicId: { type: String, default: "" } },
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

export const Bank = mongoose.model("Bank", bankSchema);
