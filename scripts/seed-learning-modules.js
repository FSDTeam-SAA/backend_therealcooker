import "../loadEnv.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { Learning } from "../model/learning.model.js";
import { User } from "../model/user.model.js";
import { normalizeQuestions } from "../utils/learningQuiz.js";
import { LEARNING_MODULES_DATA } from "../utils/learningModulesData.js";

export async function seedLearningModules({ replaceAll = true } = {}) {
  const author =
    (await User.findOne({ role: "admin" }).sort({ createdAt: 1 })) ||
    (await User.findOne().sort({ createdAt: 1 }));

  if (replaceAll) {
    // Unpublish or remove legacy non-numbered learning posts so only the 10 official modules appear
    await Learning.deleteMany({
      moduleNumber: { $nin: LEARNING_MODULES_DATA.map((m) => m.moduleNumber) },
    });
  }

  const baseTime = Date.now();
  const seeded = [];

  for (const [index, mod] of LEARNING_MODULES_DATA.entries()) {
    const questions = normalizeQuestions(mod.questions);
    const existing = await Learning.findOne({ moduleNumber: mod.moduleNumber });
    // Keep createdAt ordered so even a createdAt: -1 fallback sorts Module 1 first
    const orderedCreatedAt = new Date(baseTime - index * 60 * 1000);

    if (existing) {
      const prevComparable = JSON.stringify(
        (existing.questions || []).map((q) => ({
          question: q.question,
          options: q.options.map((o) => ({ id: o.id, text: o.text })),
          correctOptionId: q.correctOptionId,
        }))
      );
      const nextComparable = JSON.stringify(
        questions.map((q) => ({
          question: q.question,
          options: q.options.map((o) => ({ id: o.id, text: o.text })),
          correctOptionId: q.correctOptionId,
        }))
      );
      existing.title = mod.title;
      existing.description = mod.description;
      existing.isPublished = true;
      existing.createdAt = orderedCreatedAt;
      if (author && !existing.author) existing.author = author._id;
      if (prevComparable !== nextComparable) {
        existing.questions = questions;
        existing.quizVersion = (existing.quizVersion || 1) + 1;
      } else {
        // Preserve question _ids while updating metadata (momoSays, profileTags, etc.)
        existing.questions = questions.map((q, qIdx) => ({
          ...q,
          _id: existing.questions[qIdx]?._id || q._id,
        }));
      }
      await existing.save();
      seeded.push(existing);
    } else {
      const created = await Learning.create({
        moduleNumber: mod.moduleNumber,
        title: mod.title,
        description: mod.description,
        questions,
        quizVersion: 1,
        author: author?._id,
        isPublished: true,
        createdAt: orderedCreatedAt,
      });
      seeded.push(created);
    }
  }

  return seeded;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  (async () => {
    try {
      if (!process.env.MONGO_URI) {
        throw new Error("MONGO_URI is required");
      }
      await mongoose.connect(process.env.MONGO_URI);
      const seeded = await seedLearningModules({ replaceAll: true });
      console.log(
        `Seeded ${seeded.length} learning modules (${seeded.reduce(
          (sum, m) => sum + (m.questions?.length || 0),
          0
        )} questions total).`
      );
    } catch (err) {
      console.error("Failed to seed learning modules:", err);
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect();
    }
  })();
}
