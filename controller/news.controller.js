import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import httpStatus from "http-status";
import sendResponse from "../utils/sendResponse.js";
import { News } from "../model/news.model.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";

// Admin: create news
export const createNews = catchAsync(async (req, res) => {
  const { title, category, description } = req.body;
  if (!title || !category || !description) {
    throw new AppError(httpStatus.BAD_REQUEST, "Missing required fields");
  }

  let coverImage;
  if (req.file) {
    const result = await uploadOnCloudinary(req.file.buffer);
    coverImage = { url: result.secure_url, public_id: result.public_id };
  }

  const news = await News.create({
    title,
    category,
    description,
    author: req.user._id,
    coverImage,
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "News created successfully",
    data: news,
  });
});

// Admin: update news
export const updateNews = catchAsync(async (req, res) => {
  const { id } = req.params;
  const news = await News.findById(id);
  if (!news) {
    throw new AppError(httpStatus.NOT_FOUND, "News not found");
  }

  const { title, category, description, isPublished } = req.body;
  if (title) news.title = title;
  if (category) news.category = category;
  if (description) news.description = description;
  if (isPublished !== undefined) news.isPublished = isPublished;
  if (req.file) {
    const result = await uploadOnCloudinary(req.file.buffer);
    news.coverImage = { url: result.secure_url, public_id: result.public_id };
  }

  await news.save();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "News updated successfully",
    data: news,
  });
});

// Admin: delete news
export const deleteNews = catchAsync(async (req, res) => {
  const { id } = req.params;
  const news = await News.findById(id);
  if (!news) {
    throw new AppError(httpStatus.NOT_FOUND, "News not found");
  }
  await news.deleteOne();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "News deleted successfully",
    data: null,
  });
});

// Public: get all news (published)
export const getNews = catchAsync(async (req, res) => {
  const { category, limit: rawLimit } = req.query;
  const filter = { isPublished: true };
  if (category) filter.category = category;
  const parsedLimit = Number.parseInt(rawLimit, 10);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 50)
    : 0;

  let query = News.find(filter).sort({ createdAt: -1 });
  if (limit > 0) query = query.limit(limit);
  const news = await query.populate("author", "name");
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "News fetched successfully",
    data: news,
  });
});

// Public: get single news
export const getNewsById = catchAsync(async (req, res) => {
  const { id } = req.params;
  const news = await News.findOne({ _id: id, isPublished: true })
    .populate("author", "name");
  if (!news) {
    throw new AppError(httpStatus.NOT_FOUND, "News not found");
  }
  // Increment views
  news.views += 1;
  await news.save();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "News fetched successfully",
    data: news,
  });
});
