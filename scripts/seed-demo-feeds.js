import "dotenv/config";
import mongoose from "mongoose";

import { News } from "../model/news.model.js";
import { User } from "../model/user.model.js";

const demoFeeds = [
  {
    title: "Fake Bank SMS: Five Signs to Check Before You Tap",
    category: "scam_alerts",
    description:
      "Scam messages often create urgency, use shortened links, or ask you to verify personal details. Pause before tapping, open your bank's official app independently, and contact the number printed on your bank card if anything feels unusual.",
    readTime: "3 min read",
    coverImage: {
      url: "/uploads/demo-feeds/fake-bank-sms.jpg",
      public_id: "demo-feeds/fake-bank-sms",
    },
  },
  {
    title: "What to Do When a Caller Claims to Be Your Bank",
    category: "fraud_warnings",
    description:
      "A genuine bank representative will never pressure you to reveal an OTP, PIN, password, or full card details. End the call, wait a moment, and call your bank through its verified support number before taking any action.",
    readTime: "4 min read",
    coverImage: {
      url: "/uploads/demo-feeds/fake-bank-caller.jpg",
      public_id: "demo-feeds/fake-bank-caller",
    },
  },
  {
    title: "Safer Online Banking in Under Five Minutes",
    category: "tips",
    description:
      "Turn on transaction alerts, use a unique passcode, review connected devices, and keep your banking app updated. These quick checks reduce the chance that an unnoticed login becomes a financial loss.",
    readTime: "4 min read",
    coverImage: {
      url: "/uploads/demo-feeds/safer-online-banking.jpg",
      public_id: "demo-feeds/safer-online-banking",
    },
  },
  {
    title: "Never Share an OTP—even with Bank Staff",
    category: "alert",
    description:
      "An OTP authorizes a specific action on your account. Anyone asking you to read it aloud, forward it, or type it into an unfamiliar page may be attempting to complete a transaction in your name.",
    readTime: "2 min read",
    coverImage: {
      url: "/uploads/demo-feeds/protect-your-otp.jpg",
      public_id: "demo-feeds/protect-your-otp",
    },
  },
  {
    title: "How Money Mule Scams Recruit Through Social Media",
    category: "warning",
    description:
      "Offers to receive or move money for a commission can involve stolen funds. Do not let another person use your account, and report unexpected deposits or suspicious job offers to your financial institution.",
    readTime: "5 min read",
    coverImage: {
      url: "/uploads/demo-feeds/money-mule-social-media.jpg",
      public_id: "demo-feeds/money-mule-social-media",
    },
  },
];

const seedDemoFeeds = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required to seed demo feeds");
  }

  await mongoose.connect(process.env.MONGO_URI);

  const author =
    (await User.findOne({ role: "admin" }).sort({ createdAt: 1 })) ||
    (await User.findOne().sort({ createdAt: 1 }));
  if (!author) {
    throw new Error("Create at least one user before seeding demo feeds");
  }

  const seededIds = [];
  const now = Date.now();
  for (const [index, feed] of demoFeeds.entries()) {
    let post = await News.findOne({ title: feed.title });
    if (!post) {
      post = new News({
        ...feed,
        author: author._id,
        isPublished: true,
        createdAt: new Date(now - index * 60 * 1000),
      });
    } else {
      post.set({
        ...feed,
        author: author._id,
        isPublished: true,
      });
    }
    await post.save();
    seededIds.push(post._id.toString());
  }

  console.log(`Seeded ${seededIds.length} demo feed posts`);
  console.log(`Feed IDs: ${seededIds.join(", ")}`);
  const latestPublished = await News.find({ isPublished: true })
    .sort({ createdAt: -1 })
    .limit(5)
    .select("title")
    .lean();
  console.log(
    `Latest published feeds: ${latestPublished
      .map((post) => post.title)
      .join(" | ")}`
  );
};

try {
  await seedDemoFeeds();
} catch (error) {
  console.error(`Demo feed seed failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
