import mongoose from "mongoose";
import AppError from "../errors/AppError.js";

export function normalizeQuestions(raw) {
  let questions = raw;
  if (typeof raw === "string") {
    try { questions = JSON.parse(raw); } catch { throw new AppError(400, "Questions must be valid JSON"); }
  }
  if (!Array.isArray(questions) || questions.length > 100) throw new AppError(400, "Provide up to 100 questions");
  const ids = new Set();
  return questions.map((q) => {
    if (!q || typeof q.question !== "string" || !q.question.trim() || !Array.isArray(q.options) || q.options.length !== 4) {
      throw new AppError(400, "Each question needs text and four options");
    }
    const id = q._id || new mongoose.Types.ObjectId().toString();
    if (!mongoose.isValidObjectId(id) || ids.has(String(id))) throw new AppError(400, "Invalid or duplicate question ID");
    ids.add(String(id));
    const options = q.options.map((o) => {
      if (!o || typeof o.id !== "string" || !o.id.trim() || typeof o.text !== "string" || !o.text.trim()) throw new AppError(400, "Each option needs an ID and text");
      return { id: o.id.trim(), text: o.text.trim() };
    });
    if (new Set(options.map(o => o.id)).size !== 4 || !options.some(o => o.id === q.correctOptionId)) throw new AppError(400, "Choose one valid correct option");
    if (q.explanation !== undefined && typeof q.explanation !== "string") throw new AppError(400, "Explanation must be text");
    return { _id: String(id), question: q.question.trim(), options, correctOptionId: q.correctOptionId, explanation: q.explanation?.trim() || "" };
  });
}

export function gradeAnswers(questions, answers) {
  if (!questions.length) throw new AppError(400, "This learning has no quiz");
  if (!Array.isArray(answers) || answers.length !== questions.length) throw new AppError(400, "Answer every question exactly once");
  const selected = new Map();
  for (const answer of answers) {
    if (!answer || typeof answer.questionId !== "string" || selected.has(answer.questionId)) throw new AppError(400, "Invalid or duplicate answer");
    selected.set(answer.questionId, answer.optionId);
  }
  return questions.map(q => {
    const optionId = selected.get(String(q._id));
    if (!q.options.some(o => o.id === optionId)) throw new AppError(400, "Invalid question or option");
    return { questionId: String(q._id), question: q.question, options: q.options.map(o => ({ id: o.id, text: o.text })), selectedOptionId: optionId, correctOptionId: q.correctOptionId, explanation: q.explanation || "", isCorrect: optionId === q.correctOptionId };
  });
}
