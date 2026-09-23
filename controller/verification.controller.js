import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import httpStatus from "http-status";
import sendResponse from "../utils/sendResponse.js";
import { Verification } from "../model/verification.model.js";

const LOOKUP_TYPES = new Set(["email", "phone", "account", "website"]);
const VERIFIED_STATUSES = new Set([
  "verified",
  "valid",
  "trusted",
  "safe",
  "approved",
]);
const FRAUDULENT_STATUSES = new Set([
  "fraud",
  "fraudulent",
  "blacklisted",
  "flagged",
  "scam",
  "unsafe",
  "blocked",
  "suspicious",
  "reported",
]);

export const normalizeAdminVerificationStatus = (rawStatus) => {
  const status = String(rawStatus ?? "").trim().toLowerCase();
  if (!status || status === "verified") return "verified";
  if (status === "fraud" || status === "fraudulent") {
    return "fraudulent";
  }
  throw new AppError(
    httpStatus.BAD_REQUEST,
    'Status must be either "verified" or "fraudulent"'
  );
};

const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const detectVerificationType = (rawValue) => {
  const value = String(rawValue ?? "").trim();
  if (value.includes("@")) return "email";
  if (
    /^(?:https?:\/\/|www\.)/i.test(value) ||
    /^[^\s]+\.[a-z]{2,}(?:[/?#]|$)/i.test(value)
  ) {
    return "website";
  }

  const digits = value.replace(/\D/g, "");
  if (
    digits.length >= 7 &&
    digits.length <= 15 &&
    /^[+\d\s().-]+$/.test(value)
  ) {
    return "phone";
  }
  return "account";
};

export const normalizeVerificationValue = (rawValue, type) => {
  const value = String(rawValue ?? "").trim();

  switch (type) {
    case "email":
      return value.toLowerCase();
    case "phone":
      return value.replace(/\D/g, "");
    case "account":
      return value.toLowerCase().replace(/[\s-]+/g, "");
    case "website": {
      if (!value) return "";
      try {
        const parsed = new URL(
          /^(?:https?:)?\/\//i.test(value) ? value : `https://${value}`
        );
        const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
        const path = parsed.pathname.replace(/\/+$/, "");
        return `${host}${path}`;
      } catch {
        return value
          .toLowerCase()
          .replace(/^(?:https?:\/\/)?(?:www\.)?/, "")
          .replace(/[/?#]+$/, "");
      }
    }
    default:
      return value;
  }
};

export const normalizeVerificationStatus = (rawStatus) => {
  const status = String(rawStatus ?? "").trim().toLowerCase();
  if (VERIFIED_STATUSES.has(status)) return "verified";
  if (
    FRAUDULENT_STATUSES.has(status) ||
    /fraud|scam|flag|blacklist|unsafe|suspicious|blocked|reported/.test(status)
  ) {
    return "fraudulent";
  }

  // A record that is present but does not carry an explicitly trusted status
  // must never be presented to the user as verified.
  return "fraudulent";
};

export const buildVerificationLookupFilter = (type, normalizedValue) => {
  if (type === "email") {
    return { email: new RegExp(`^${escapeRegExp(normalizedValue)}$`, "i") };
  }

  if (type === "website") {
    return {
      website: new RegExp(
        `^(?:https?:\\/\\/)?(?:www\\.)?${escapeRegExp(normalizedValue)}\\/?(?:[?#].*)?$`,
        "i"
      ),
    };
  }

  const separator = type === "phone" ? "[\\s().+-]*" : "[\\s-]*";
  const characters = [...normalizedValue]
    .map((character) => escapeRegExp(character))
    .join(separator);
  return { [type]: new RegExp(`^${separator}${characters}${separator}$`, "i") };
};

const validateLookupValue = (value, type, rawValue) => {
  const raw = String(rawValue ?? "").trim();
  if (raw.length > 2048) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "The verification value is too long"
    );
  }
  if (!value) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "A value is required to run a verification check"
    );
  }
  if (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Enter a valid email address");
  }
  if (type === "phone" && !/^\d{7,15}$/.test(value)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Enter a valid phone number");
  }
  if (type === "phone" && !/^[+\d\s().-]+$/.test(raw)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Enter a valid phone number");
  }
  if (type === "website" && !/^[^\s.]+(?:\.[^\s.]+)+(?:\/.*)?$/.test(value)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Enter a valid website address");
  }
};

// Public: check a single email, phone, account number, or website against the
// records maintained by admins. The endpoint intentionally returns HTTP 200
// for all three verdicts so a clean "not found" result is not treated as a
// transport error by mobile clients.
export const checkVerification = catchAsync(async (req, res) => {
  const rawValue = req.body?.value ?? req.query?.value ?? req.query?.query;
  const requestedType = String(req.body?.type ?? req.query?.type ?? "")
    .trim()
    .toLowerCase();
  const type = requestedType || detectVerificationType(rawValue);

  if (!LOOKUP_TYPES.has(type)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Type must be one of: email, phone, account, website"
    );
  }

  const normalizedValue = normalizeVerificationValue(rawValue, type);
  validateLookupValue(normalizedValue, type, rawValue);

  const record = await Verification.findOne(
    buildVerificationLookupFilter(type, normalizedValue)
  )
    .sort({ createdAt: -1 })
    .lean();

  if (!record) {
    const message =
      "No record found for this information in our database. Exercise caution.";
    return res.status(httpStatus.OK).json({
      success: true,
      status: "not_found",
      message,
      data: {
        status: "not_found",
        type,
        value: normalizedValue,
        details: null,
        message,
      },
    });
  }

  const status = normalizeVerificationStatus(record.status);
  const message =
    status === "verified"
      ? "This entity is verified."
      : "Warning: Flagged as fraudulent.";

  return res.status(httpStatus.OK).json({
    success: true,
    status,
    message,
    data: {
      status,
      type,
      value: normalizedValue,
      message,
      details: {
        type,
        value: normalizeVerificationValue(record[type], type),
        recordedAt: record.createdAt,
      },
    },
  });
});

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
    status: normalizeAdminVerificationStatus(status),
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
  if (status !== undefined) {
    record.status = normalizeAdminVerificationStatus(status);
  }

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
  const statusIdx = headers.findIndex(
    (h) => h === "status" || h === "verificationstatus"
  );

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
    const rawStatus = statusIdx !== -1 ? (row[statusIdx] || "").trim() : "";

    // Skip completely empty rows
    if (!email && !phone && !account && !website) continue;

    let status;
    try {
      status = normalizeAdminVerificationStatus(rawStatus);
    } catch {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Invalid status on CSV row ${i + 1}. Use "verified" or "fraudulent".`
      );
    }

    recordsToInsert.push({
      email,
      phone,
      account,
      website,
      status,
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
