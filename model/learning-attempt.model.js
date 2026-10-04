import mongoose, { Schema } from "mongoose";

const answerSchema = new Schema({
  questionId: { type: String, required: true },
  question: { type: String, required: true },
  options: [{ id: String, text: String, _id: false }],
  selectedOptionId: { type: String, required: true },
  correctOptionId: { type: String, required: true },
  explanation: String,
  isCorrect: { type: Boolean, required: true },
}, { _id: false });
const schema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  learning: { type: Schema.Types.ObjectId, ref: "Learning", required: true },
  learningTitle: { type: String, required: true },
  quizVersion: { type: Number, required: true },
  answers: [answerSchema],
  score: { type: Number, required: true },
  totalQuestions: { type: Number, required: true },
}, { timestamps: true });
schema.index({ learning: 1, createdAt: -1 });
schema.index({ user: 1, learning: 1, createdAt: -1 });
export const LearningAttempt = mongoose.model("LearningAttempt", schema);
