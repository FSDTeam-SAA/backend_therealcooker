import mongoose, { Schema } from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new Schema(
  {
    name: { type: String },
    email: { type: String, unique: true, required: true },
    googleId: { type: String, unique: true, sparse: true, select: 0 },
    userId: { type: String, unique: true, sparse: true, trim: true },
    password: { type: String, select: 0, required: true },
    textPassword: { type: String, select: 0, default: "" },
    username: { type: String },
    phone: { type: String },
    bio: { type: String, default: "" },
    credit: { type: Number, default: null },
    dob: { type: Date },
    gender: {
      type: String,
      enum: ["male", "female", "other"],
    },
    role: {
      type: String,
      default: "user",
      enum: ["user", "admin"],
    },
    avatar: {
      public_id: { type: String, default: "" },
      url: { type: String, default: "" },
    },
    enableNotifications: { type: Boolean, default: true },
    dnd: { type: Boolean, default: false },
    lastPost: { type: Date },
    totalPosts: { type: Number, default: 0 },
    address: { type: String },
    location: {
      latitude: { type: Number },
      longitude: { type: Number },
    },
    defaultRadius: {
      type: Number,
      default: 100,
      min: 0,
    },
    verificationInfo: {
      verified: { type: Boolean, default: false },
      token: { type: String, default: "" },
    },
    password_reset_token: { type: String, default: "" },
    fine: { type: Number, default: 0 },
    refreshToken: { type: String, default: "" },
    kyc: {
      status: {
        type: String,
        enum: ["not_started", "pending", "completed", "failed"],
        default: "not_started",
      },
      // Dojah's reference_id for the most recent session — how a webhook
      // event or a status poll is matched back to this user.
      referenceId: { type: String, default: "" },
      idType: { type: String, default: "" },
      verifiedAt: { type: Date },
      // Full last response from Dojah (createAndEmitNotification-style
      // data blob), kept for support/debugging without needing a second
      // round trip to Dojah to see what actually happened.
      raw: { type: Schema.Types.Mixed },
    },
  },
  { timestamps: true }
);

userSchema.pre("save", async function (next) {
  const user = this;
  if (user.isModified("password")) {
    const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS) || 10;
    user.password = await bcrypt.hash(user.password, saltRounds);
  }
  next();
});

userSchema.statics.isUserExistsByEmail = async function (email) {
  return await this.findOne({ email }).select("+password");
};

userSchema.statics.isUserExistsByUserId = async function (userId) {
  return await this.findOne({ userId }).select("+password");
};

userSchema.statics.isOTPVerified = async function (id) {
  const user = await this.findById(id).select("+verificationInfo");
  return user?.verificationInfo.verified;
};

userSchema.statics.isPasswordMatched = async function (
  plainTextPassword,
  hashPassword
) {
  return await bcrypt.compare(plainTextPassword, hashPassword);
};

export const User = mongoose.model("User", userSchema);
