import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import httpStatus from "http-status";
import sendResponse from "../utils/sendResponse.js";
import { Verification } from "../model/verification.model.js";

// Helper: robust CSV string parser handling quotes and commas
function parseCSV(content) {
  const lines = [];
  let row = [];
  let cell = "";
  let insideQuote = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (insideQuote && nextChar === '"') {
        cell += '"';
        i++; // skip escaped quote
      } else {
        insideQuote = !insideQuote;
      }
    } else if (char === "," && !insideQuote) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\r" || char === "\n") && !insideQuote) {
      if (char === "\r" && nextChar === "\n") {
        i++; // skip CRLF
      }
      row.push(cell.trim());
      if (row.some((val) => val.length > 0)) {
        lines.push(row);
      }
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((val) => val.length > 0)) {
      lines.push(row);
    }
  }

  return lines;
}

// Get all verifications with search & pagination
export const getVerifications = catchAsync(async (req, res) => {
  const { search, page: rawPage, limit: rawLimit } = req.query;

  const filter = {};
  if (search && search.trim()) {
    const term = search.trim();
    filter.$or = [
      { email: { $regex: term, $options: "i" } },
      { phone: { $regex: term, $options: "i" } },
      { account: { $regex: term, $options: "i" } },
      { website: { $regex: term, $options: "i" } },
    ];
  }

  const page = Math.max(1, Number.parseInt(rawPage, 10) || 1);
  const limit = Math.max(1, Math.min(100, Number.parseInt(rawLimit, 10) || 10));
  const skip = (page - 1) * limit;

  const total = await Verification.countDocuments(filter);
  const totalPages = Math.ceil(total / limit) || 1;

  const verifications = await Verification.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Verifications fetched successfully",
    data: {
      verifications,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    },
  });
});

// Create single verification
export const createVerification = catchAsync(async (req, res) => {
  const { email, phone, account, website, status } = req.body;

  if (!email && !phone && !account && !website) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "At least one field (email, phone, account, website) must be provided"
    );
  }

  const record = await Verification.create({
    email: email || "",
    phone: phone || "",
    account: account || "",
    website: website || "",
    status: status || "verified",
    source: "manual",
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Verification created successfully",
    data: record,
  });
});

// Update verification
export const updateVerification = catchAsync(async (req, res) => {
  const { id } = req.params;
  const record = await Verification.findById(id);
  if (!record) {
    throw new AppError(httpStatus.NOT_FOUND, "Verification record not found");
  }

  const { email, phone, account, website, status } = req.body;
  if (email !== undefined) record.email = email;
  if (phone !== undefined) record.phone = phone;
  if (account !== undefined) record.account = account;
  if (website !== undefined) record.website = website;
  if (status !== undefined) record.status = status;

  await record.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Verification updated successfully",
    data: record,
  });
});

// Delete verification
export const deleteVerification = catchAsync(async (req, res) => {
  const { id } = req.params;
  const record = await Verification.findById(id);
  if (!record) {
    throw new AppError(httpStatus.NOT_FOUND, "Verification record not found");
  }

  await record.deleteOne();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Verification deleted successfully",
    data: null,
  });
});

// Upload and import CSV file
export const uploadVerificationCSV = catchAsync(async (req, res) => {
  if (!req.file) {
    throw new AppError(httpStatus.BAD_REQUEST, "CSV file is required");
  }

  const fileContent = req.file.buffer.toString("utf-8");
  const parsedRows = parseCSV(fileContent);

  if (parsedRows.length < 2) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "CSV must contain a header row and at least one data row"
    );
  }

  // Header matching
  const headers = parsedRows[0].map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const emailIdx = headers.findIndex((h) => h.includes("email"));
  const phoneIdx = headers.findIndex((h) => h.includes("phone") || h.includes("mobile") || h.includes("tel"));
  const accountIdx = headers.findIndex((h) => h.includes("account") || h.includes("acc"));
  const websiteIdx = headers.findIndex((h) => h.includes("web") || h.includes("site") || h.includes("url"));

  if (emailIdx === -1 && phoneIdx === -1 && accountIdx === -1 && websiteIdx === -1) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "CSV headers must contain at least one of: email, phone, account, website"
    );
  }

  const recordsToInsert = [];
  for (let i = 1; i < parsedRows.length; i++) {
    const row = parsedRows[i];
    const email = emailIdx !== -1 ? (row[emailIdx] || "").trim() : "";
    const phone = phoneIdx !== -1 ? (row[phoneIdx] || "").trim() : "";
    const account = accountIdx !== -1 ? (row[accountIdx] || "").trim() : "";
    const website = websiteIdx !== -1 ? (row[websiteIdx] || "").trim() : "";

    // Skip completely empty rows
    if (!email && !phone && !account && !website) continue;

    recordsToInsert.push({
      email,
      phone,
      account,
      website,
      status: "verified",
      source: "csv",
    });
  }

  if (recordsToInsert.length === 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "No valid records found in CSV");
  }

  const inserted = await Verification.insertMany(recordsToInsert);

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: `Successfully imported ${inserted.length} verification records from CSV`,
    data: {
      count: inserted.length,
    },
  });
});
