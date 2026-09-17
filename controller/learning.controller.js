import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import httpStatus from "http-status";
import sendResponse from "../utils/sendResponse.js";
import { Learning } from "../model/learning.model.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";

// Admin: Create learning item
export const createLearning = catchAsync(async (req, res) => {
  const { title, description } = req.body;
  if (!title || !description) {
    throw new AppError(httpStatus.BAD_REQUEST, "Title and description are required");
  }

  let image;
  if (req.file) {
    const result = await uploadOnCloudinary(req.file.buffer);
    image = { url: result.secure_url, public_id: result.public_id };
  }

  const learning = await Learning.create({
    title,
    description,
    image,
    author: req.user?._id,
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Learning item created successfully",
    data: learning,
  });
});

// Admin: Update learning item
export const updateLearning = catchAsync(async (req, res) => {
  const { id } = req.params;
  const learning = await Learning.findById(id);
  if (!learning) {
    throw new AppError(httpStatus.NOT_FOUND, "Learning item not found");
  }

  const { title, description, isPublished } = req.body;
  if (title) learning.title = title;
  if (description) learning.description = description;
  if (isPublished !== undefined) learning.isPublished = isPublished;

  if (req.file) {
    const result = await uploadOnCloudinary(req.file.buffer);
    learning.image = { url: result.secure_url, public_id: result.public_id };
  }

  await learning.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Learning item updated successfully",
    data: learning,
  });
});

// Admin: Delete learning item
export const deleteLearning = catchAsync(async (req, res) => {
  const { id } = req.params;
  const learning = await Learning.findById(id);
  if (!learning) {
    throw new AppError(httpStatus.NOT_FOUND, "Learning item not found");
  }

  await learning.deleteOne();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Learning item deleted successfully",
    data: null,
  });
});

// Public / Admin: Get all learning items (supports search & pagination)
export const getLearnings = catchAsync(async (req, res) => {
  const { search, page: rawPage, limit: rawLimit } = req.query;

  const filter = {};
  if (search && search.trim()) {
    filter.$or = [
      { title: { $regex: search.trim(), $options: "i" } },
      { description: { $regex: search.trim(), $options: "i" } },
    ];
  }

  const page = Math.max(1, Number.parseInt(rawPage, 10) || 1);
  const limit = Math.max(1, Math.min(100, Number.parseInt(rawLimit, 10) || 10));
  const skip = (page - 1) * limit;

  const total = await Learning.countDocuments(filter);
  const totalPages = Math.ceil(total / limit) || 1;

  const learnings = await Learning.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("author", "name email");

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Learning items fetched successfully",
    data: {
      learnings,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    },
  });
});

// Public / Admin: Get single learning item
export const getLearningById = catchAsync(async (req, res) => {
  const { id } = req.params;
  const learning = await Learning.findById(id).populate("author", "name email");
  if (!learning) {
    throw new AppError(httpStatus.NOT_FOUND, "Learning item not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Learning item fetched successfully",
    data: learning,
  });
});
