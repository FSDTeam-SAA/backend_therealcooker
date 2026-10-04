import jwt from "jsonwebtoken";
import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { User } from "./../model/user.model.js";
import { isValidObjectId } from "mongoose";

export const protect = async (req, res, next) => {
  const authorization = req.headers.authorization;
  const token = typeof authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] : undefined;
  if (!token) throw new AppError(httpStatus.UNAUTHORIZED, "Please log in to continue");
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });
  } catch (err) {
    throw new AppError(httpStatus.UNAUTHORIZED, err.name === "TokenExpiredError" ? "Session expired. Please log in again." : "Invalid session. Please log in again.");
  }
  if (!decoded || typeof decoded !== "object" || !isValidObjectId(decoded._id)) throw new AppError(httpStatus.UNAUTHORIZED, "Invalid session. Please log in again.");
  // Database/service failures must remain server errors, not invalid-token errors.
  const user = await User.findById(decoded._id);
  if (!user || !user.verificationInfo?.verified || user.isBlocked) throw new AppError(httpStatus.UNAUTHORIZED, "Session is no longer valid. Please log in again.");
  req.user = user;
  next();
};

export const isAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    throw new AppError(403, "Access denied. You are not an admin.");
  }
  next();
};

export const isDriver = (req, res, next) => {
  if (req.user?.role !== "driver") {
    throw new AppError(403, "Access denied. You are not an driver.");
  }
  next();
};
