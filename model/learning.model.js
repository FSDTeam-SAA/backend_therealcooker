import mongoose, { Schema } from "mongoose";

const learningSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    questions: {
      type: [new Schema({
        question: { type: String, required: true, trim: true },
        options: [{ id: { type: String, required: true }, text: { type: String, required: true, trim: true }, _id: false }],
        correctOptionId: { type: String, required: true },
        explanation: { type: String, default: "" },
      })],
      default: [],
    },
    quizVersion: { type: Number, default: 1 },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    image: {
      url: { type: String, default: "" },
      public_id: { type: String, default: "" },
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    isPublished: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

export const Learning = mongoose.model("Learning", learningSchema);
