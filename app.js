// ==========================================
// QuickTest Backend - Structured MVP v3
// Admin Secret + Quiz History + PDF Workflow
// ==========================================
require('dotenv').config();
const dns = require("dns");
if (!process.env.VERCEL) {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
}

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const INSECURE_EXPOSE_RESET_TOKEN = process.env.INSECURE_EXPOSE_RESET_TOKEN === "true";
const cors=require("cors");

const app = express();
app.use(express.json());
app.use(cors('*'))

// serve uploaded files so frontend can download them
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// explicit download route (fallback for some environments)
app.get('/uploads/*requestedPath', async (req, res) => {
  const requestedParam = req.params.requestedPath;
  const rawRequestedPath = Array.isArray(requestedParam)
    ? requestedParam.join('/')
    : requestedParam;
  const requestedPath = rawRequestedPath ? decodeURIComponent(rawRequestedPath) : rawRequestedPath;

  if (!requestedPath) {
    return res.status(404).send('Not found');
  }

  // First try local file (backward compatibility for older stored uploads)
  const filePath = path.join(__dirname, 'uploads', requestedPath);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  // Then try Cloudinary-backed records (for new serverless uploads)
  try {
    const objectIdQuery = mongoose.Types.ObjectId.isValid(requestedPath)
      ? [{ _id: requestedPath }]
      : [];
    const keyCandidates = Array.from(new Set([
      requestedPath,
      requestedPath.replace(/^\/+/, ""),
      `quicktest/uploads/${requestedPath.replace(/^\/+/, "")}`,
      `quicktest/pdfs/${requestedPath.replace(/^\/+/, "")}`
    ]));
    const keyQueries = keyCandidates.flatMap((candidate) => ([
      { filename: candidate },
      { cloudinaryPublicId: candidate }
    ]));

    const uploadRecord = await PdfUpload.findOne({
      $or: [
        ...keyQueries,
        ...objectIdQuery
      ]
    });

    if (uploadRecord?.fileUrl) {
      return res.redirect(uploadRecord.fileUrl);
    }
  } catch (error) {
    console.error('uploads lookup error for', requestedPath, error);
  }

  return res.status(404).send('Not found');
});

/* ==========================================
   CONFIG
========================================== */

const crypto = require("crypto");

const PORT =process.env.PORT|| 5000;

function getCloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (cloudName && apiKey && apiSecret) {
    return { cloudName, apiKey, apiSecret };
  }

  const cloudinaryUrl = process.env.CLOUDINARY_URL;
  if (!cloudinaryUrl) return null;

  try {
    const parsed = new URL(cloudinaryUrl);
    const derivedCloudName = parsed.hostname;
    const derivedApiKey = decodeURIComponent(parsed.username || "");
    const derivedApiSecret = decodeURIComponent(parsed.password || "");

    if (derivedCloudName && derivedApiKey && derivedApiSecret) {
      return {
        cloudName: derivedCloudName,
        apiKey: derivedApiKey,
        apiSecret: derivedApiSecret
      };
    }
  } catch (error) {
    console.warn("Invalid CLOUDINARY_URL format.");
  }

  return null;
}

const cloudinaryConfig = getCloudinaryConfig();
const hasCloudinaryConfig = !!cloudinaryConfig;

if (!hasCloudinaryConfig) {
  console.warn("Cloudinary is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET.");
}

const PDF_MIME_TYPES = new Set([
  "application/pdf",
  "application/x-pdf",
  "application/acrobat",
  "applications/vnd.pdf",
  "text/pdf",
  "text/x-pdf",
  "application/octet-stream"
]);

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif"
]);

function isPdfBuffer(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function resolveUploadKind(file) {
  const mimeType = String(file?.mimetype || "").toLowerCase().trim();
  const originalname = String(file?.originalname || "");
  const hasPdfExtension = /\.pdf$/i.test(originalname);
  const looksLikePdf = isPdfBuffer(file?.buffer);

  if (mimeType.startsWith("image/") && IMAGE_MIME_TYPES.has(mimeType)) {
    return { allowed: true, normalizedMimeType: mimeType };
  }

  if (PDF_MIME_TYPES.has(mimeType) && (looksLikePdf || hasPdfExtension)) {
    return { allowed: true, normalizedMimeType: "application/pdf" };
  }

  if (hasPdfExtension && looksLikePdf) {
    return { allowed: true, normalizedMimeType: "application/pdf" };
  }

  return { allowed: false, normalizedMimeType: mimeType };
}

function buildUploadFilename(originalname, mimeType) {
  const normalizedBaseName = (originalname || "upload")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 40) || "file";

  const extensionByMimeType = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif"
  };

  const extension = extensionByMimeType[mimeType] || "bin";
  return `${normalizedBaseName}.${extension}`;
}

async function uploadFileToCloudinary(fileBuffer, originalname, mimeType) {
  const timestamp = Math.floor(Date.now() / 1000);
  const normalizedName = (originalname || "upload")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 40);
  const publicId = `file-${Date.now()}-${normalizedName || "file"}`;
  const folder = "quicktest/uploads";

  const paramsToSign = {
    folder,
    public_id: publicId,
    timestamp
  };

  const signaturePayload = Object.keys(paramsToSign)
    .sort()
    .map((key) => `${key}=${paramsToSign[key]}`)
    .join("&");

  const signature = crypto
    .createHash("sha1")
    .update(`${signaturePayload}${cloudinaryConfig.apiSecret}`)
    .digest("hex");

  const uploadFilename = buildUploadFilename(originalname, mimeType);
  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mimeType }), uploadFilename);
  form.append("api_key", cloudinaryConfig.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  form.append("folder", folder);
  form.append("public_id", publicId);

  const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudName}/auto/upload`;
  const response = await fetch(uploadUrl, { method: "POST", body: form });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Cloudinary upload failed");
  }

  return data;
}

async function deleteFileFromCloudinary(publicId, resourceType = "image") {
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = {
    public_id: publicId,
    timestamp
  };

  const signaturePayload = Object.keys(paramsToSign)
    .sort()
    .map((key) => `${key}=${paramsToSign[key]}`)
    .join("&");

  const signature = crypto
    .createHash("sha1")
    .update(`${signaturePayload}${cloudinaryConfig.apiSecret}`)
    .digest("hex");

  const form = new FormData();
  form.append("public_id", publicId);
  form.append("api_key", cloudinaryConfig.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);

  const destroyUrl = `https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudName}/${resourceType}/destroy`;
  const response = await fetch(destroyUrl, { method: "POST", body: form });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Cloudinary delete failed");
  }

  return data;
}

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.error("MongoDB Error:", err));

/* ==========================================
   SCHEMAS
========================================== */

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
  resetPasswordToken: String,
  resetPasswordExpires: Date
}, { timestamps: true });

const questionSchema = new mongoose.Schema({
  course: { type: String, required: true },
  topic: { type: String, required: true },
  question_latex: { type: String, required: true },
  option_a: String,
  option_b: String,
  option_c: String,
  option_d: String,
  correct_option: { type: String, required: true },
  difficulty: { type: String, required: true },
  solution_latex: String,
  qualityScore: { type: Number, default: 100 },
  qualityIssues: { type: [String], default: [] },
  needsReview: { type: Boolean, default: false }
}, { timestamps: true });

questionSchema.index(
  { course: 1, topic: 1, question_latex: 1 },
  { unique: true }
);

const quizAttemptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  score: Number,
  total: Number,
  percentage: Number,
  course: String,
  topic: String,
  answers: [
    {
      questionId: mongoose.Schema.Types.ObjectId,
      selectedOption: String,
      correctOption: String,
      isCorrect: Boolean
    }
  ]
}, { timestamps: true });

const pdfUploadSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  filename: String,
  originalname: String,
  fileUrl: String,
  cloudinaryPublicId: String,
  mimeType: String,
  resourceType: String,
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending"
  }
}, { timestamps: true });

const User = mongoose.model("User", userSchema);
const Question = mongoose.model("Question", questionSchema);
const QuizAttempt = mongoose.model("QuizAttempt", quizAttemptSchema);
const PdfUpload = mongoose.model("PdfUpload", pdfUploadSchema);

function flattenQuestionsPayload(rawData) {
  if (Array.isArray(rawData)) return rawData;

  let allQuestions = [];
  for (const key in rawData) {
    const arr = Array.isArray(rawData[key]) ? rawData[key] : [];
    allQuestions = allQuestions.concat(arr.map((q) => ({ ...q, courseTitle: key })));
  }
  return allQuestions;
}

const QUESTION_BANK_DIR = path.join(__dirname, "question-banks");

function attachCourseTitleFromFileName(questions, fileName) {
  const courseTitle = path.basename(fileName, path.extname(fileName));
  return questions.map((q) => ({
    ...q,
    courseTitle: q.courseTitle || courseTitle
  }));
}

function loadQuestionsFromOneFile(filePath) {
  const rawData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const flattened = flattenQuestionsPayload(rawData);
  return Array.isArray(rawData)
    ? attachCourseTitleFromFileName(flattened, path.basename(filePath))
    : flattened;
}

function loadQuestionsPayload(fileName) {
  // Default behavior: import all JSON files from question-banks folder.
  if (!fileName) {
    if (!fs.existsSync(QUESTION_BANK_DIR)) {
      throw new Error("question-banks folder is missing");
    }

    const files = fs
      .readdirSync(QUESTION_BANK_DIR)
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .sort();

    if (!files.length) {
      throw new Error("No JSON files found in question-banks folder");
    }

    const allQuestions = files.flatMap((name) =>
      loadQuestionsFromOneFile(path.join(QUESTION_BANK_DIR, name))
    );

    return { allQuestions, sourceFiles: files };
  }

  const normalizedFileName = String(fileName);
  const safeFileName = path.basename(normalizedFileName);
  if (safeFileName !== normalizedFileName) {
    throw new Error("Invalid file name");
  }

  const preferredPath = path.join(QUESTION_BANK_DIR, safeFileName);
  if (fs.existsSync(preferredPath)) {
    return {
      allQuestions: loadQuestionsFromOneFile(preferredPath),
      sourceFiles: [safeFileName]
    };
  }

  const legacyPath = path.join(__dirname, safeFileName);
  if (fs.existsSync(legacyPath)) {
    const rawData = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
    return {
      allQuestions: flattenQuestionsPayload(rawData),
      sourceFiles: [safeFileName]
    };
  }

  if (safeFileName === "questionsmvp.json") {
    if (fs.existsSync(QUESTION_BANK_DIR)) {
      const files = fs
        .readdirSync(QUESTION_BANK_DIR)
        .filter((name) => name.toLowerCase().endsWith(".json"))
        .sort();
      if (files.length) {
        const allQuestions = files.flatMap((name) =>
          loadQuestionsFromOneFile(path.join(QUESTION_BANK_DIR, name))
        );
        return { allQuestions, sourceFiles: files };
      }
    }

    try {
      return {
        allQuestions: flattenQuestionsPayload(require("./questionsmvp.json")),
        sourceFiles: [safeFileName]
      };
    } catch {
      throw new Error("questionsmvp.json not found in question-banks or deployment bundle");
    }
  }

  throw new Error(`Question file not found: ${safeFileName}`);
}

async function syncQuestionsFromFile(fileName) {
  let allQuestions = [];
  try {
    allQuestions = loadQuestionsPayload(fileName).allQuestions;
  } catch (error) {
    console.warn(`Question sync skipped: ${error.message}`);
    return;
  }

  if (!allQuestions.length) {
    console.warn("Question sync skipped: no records found in source files");
    return;
  }

  const preparedQuestions = allQuestions.map(prepareQuestionForInsert);
  const ops = preparedQuestions.map((q) => ({
    updateOne: {
      filter: {
        course: q.course,
        topic: q.topic,
        question_latex: q.question_latex
      },
      update: { $setOnInsert: q },
      upsert: true
    }
  }));

  const result = await Question.bulkWrite(ops, { ordered: false });
  const inserted = result.upsertedCount || 0;
  if (inserted > 0) {
    console.log(`Question sync completed: ${inserted} new question(s) inserted`);
  } else {
    console.log("Question sync completed: no new questions to insert");
  }
}

if (mongoose.connection.readyState === 1) {
  syncQuestionsFromFile().catch((error) => {
    console.error("Automatic question sync failed:", error);
  });
} else {
  mongoose.connection.once("open", () => {
    syncQuestionsFromFile().catch((error) => {
      console.error("Automatic question sync failed:", error);
    });
  });
}

/* ==========================================
   AUTH MIDDLEWARE
========================================== */

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
};

const adminMiddleware = async (req, res, next) => {
  const user = await User.findById(req.user.id);
  if (!user || !user.isAdmin)
    return res.status(403).json({ message: "Admin access required" });

  next();
};

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeUsername(value) {
  return String(value || "").trim();
}

function hashResetToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken || "")).digest("hex");
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  if (max && parsed > max) return max;
  return parsed;
}

function getMostFrequentValue(values) {
  const counts = new Map();
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  let bestValue = "";
  let bestCount = 0;
  for (const [value, count] of counts.entries()) {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  }
  return bestValue;
}

async function enrichAttemptsWithInferredMetadata(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) return attempts;

  const questionIdSet = new Set();
  for (const attempt of attempts) {
    const answers = Array.isArray(attempt.answers) ? attempt.answers : [];
    for (const ans of answers) {
      if (ans?.questionId) {
        questionIdSet.add(String(ans.questionId));
      }
    }
  }

  if (!questionIdSet.size) return attempts;

  const questionDocs = await Question.find({
    _id: { $in: Array.from(questionIdSet) }
  }).select("_id course topic").lean();

  const questionById = new Map(
    questionDocs.map((q) => [String(q._id), q])
  );

  return attempts.map((attempt) => {
    const hasCourse = String(attempt.course || "").trim().length > 0;
    const hasTopic = String(attempt.topic || "").trim().length > 0;
    if (hasCourse && hasTopic) return attempt;

    const answers = Array.isArray(attempt.answers) ? attempt.answers : [];
    const inferredCourses = [];
    const inferredTopics = [];

    for (const ans of answers) {
      const q = questionById.get(String(ans?.questionId || ""));
      if (!q) continue;
      if (q.course) inferredCourses.push(q.course);
      if (q.topic) inferredTopics.push(q.topic);
    }

    const inferredCourse = getMostFrequentValue(inferredCourses);
    const inferredTopic = getMostFrequentValue(inferredTopics);

    return {
      ...attempt,
      course: hasCourse ? attempt.course : inferredCourse || "General",
      topic: hasTopic ? attempt.topic : inferredTopic || "Mixed Topics"
    };
  });
}

/* ==========================================
   REGISTER (ONE ADMIN ONLY)
========================================== */

app.post("/api/register", async (req, res) => {
  try {
    const { username, password, adminSecret } = req.body;
    const normalizedUsername = normalizeUsername(username);

    if (!normalizedUsername || !password)
      return res.status(400).json({ message: "Username and password required" });

    const usernameRegex = new RegExp(`^${escapeRegex(normalizedUsername)}$`, "i");
    const existingUser = await User.findOne({ username: usernameRegex });
    if (existingUser)
      return res.status(400).json({ message: "Username already taken" });

    let isAdmin = false;

    if (adminSecret) {
      const existingAdmin = await User.findOne({ isAdmin: true });

      if (adminSecret !== ADMIN_SECRET)
        return res.status(403).json({ message: "Invalid admin secret" });

      if (existingAdmin)
        return res.status(403).json({ message: "Admin already exists" });

      isAdmin = true;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await User.create({ username: normalizedUsername, password: hashedPassword, isAdmin });

    res.json({
      message: isAdmin
        ? "Admin registered successfully"
        : "User registered successfully"
    });

  } catch (err) {
  console.log("REGISTER ERROR:", err);

  if (err.code === 11000) {
    return res.status(400).json({ message: "Username already taken" });
  }

  res.status(500).json({ message: "Server error" });
}
});

/* ==========================================
   LOGIN
========================================== */

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername || !password)
    return res.status(400).json({ message: "Invalid credentials" });

  const usernameRegex = new RegExp(`^${escapeRegex(normalizedUsername)}$`, "i");
  const user = await User.findOne({ username: usernameRegex });
  if (!user) return res.status(400).json({ message: "Invalid credentials" });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ message: "Invalid credentials" });

  const token = jwt.sign(
    { id: user._id, username: user.username },
    JWT_SECRET
  );

  res.json({ token, isAdmin: user.isAdmin });
});

/* ==========================================
   PASSWORD RESET (MINIMAL TOKEN FLOW)
========================================== */

app.post("/api/forgot-password", async (req, res) => {
  try {
    const normalizedUsername = normalizeUsername(req.body?.username);
    const genericMessage = "If the account exists, a reset token has been generated.";

    if (!normalizedUsername) {
      return res.status(200).json({ message: genericMessage });
    }

    const usernameRegex = new RegExp(`^${escapeRegex(normalizedUsername)}$`, "i");
    const user = await User.findOne({ username: usernameRegex });

    if (!user) {
      return res.status(200).json({ message: genericMessage });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = hashResetToken(rawToken);
    user.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await user.save();

    const responseBody = {
      message: genericMessage,
      expiresInSeconds: 15 * 60
    };

    // Only expose raw token when explicitly enabled for local/testing use.
    if (INSECURE_EXPOSE_RESET_TOKEN) {
      responseBody.resetToken = rawToken;
    }

    return res.status(200).json(responseBody);
  } catch (error) {
    console.error("forgot-password error:", error);
    return res.status(500).json({ message: "Failed to start password reset" });
  }
});

app.post("/api/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};

    if (!token || !newPassword) {
      return res.status(400).json({ message: "Token and newPassword are required" });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const hashedToken = hashResetToken(token);
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired reset token" });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    return res.json({ message: "Password reset successful" });
  } catch (error) {
    console.error("reset-password error:", error);
    return res.status(500).json({ message: "Failed to reset password" });
  }
});

/* ==========================================
   IMPORT QUESTIONS (ADMIN ONLY)
========================================== */

app.post("/api/import", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const fileName = req.body?.fileName;
    const { allQuestions, sourceFiles } = loadQuestionsPayload(fileName);
    const preparedQuestions = allQuestions.map(prepareQuestionForInsert);

    let inserted = 0;
    let skipped = 0;

    for (let q of preparedQuestions) {
      try {
        await Question.create(q);
        inserted++;
      } catch {
        skipped++;
      }
    }

    res.json({ inserted, skipped, sourceFiles });

  } catch (err) {
    console.log("IMPORT ERROR:", err);
    res.status(500).json({
      message: "Import failed",
      error: err.message
    });
  }
});
/* ==========================================
   METADATA ENDPOINT (courses/topics)
   returns all distinct values from the question collection
========================================== */

app.get("/api/metadata", authMiddleware, async (req, res) => {
  try {
    const [coursesResult, topicsResult, difficultiesResult, titleAggResult, topicsByCourseAggResult] =
      await Promise.allSettled([
        Question.distinct("course"),
        Question.distinct("topic"),
        Question.distinct("difficulty"),
        Question.aggregate([
          { $match: { courseTitle: { $exists: true, $ne: null } } },
          { $group: { _id: "$course", title: { $first: "$courseTitle" } } }
        ]),
        Question.aggregate([
          { $match: { course: { $exists: true, $ne: null } } },
          { $group: { _id: "$course", topics: { $addToSet: "$topic" } } }
        ])
      ]);

    const courses = coursesResult.status === "fulfilled"
      ? coursesResult.value.filter(Boolean).map((v) => String(v))
      : [];
    const topics = topicsResult.status === "fulfilled"
      ? topicsResult.value.filter(Boolean).map((v) => String(v))
      : [];
    const difficulties = difficultiesResult.status === "fulfilled"
      ? difficultiesResult.value.filter(Boolean).map((v) => String(v))
      : [];

    const courseTitles = {};
    if (titleAggResult.status === "fulfilled") {
      titleAggResult.value.forEach((row) => {
        if (!row?._id) return;
        courseTitles[String(row._id)] = String(row.title || row._id);
      });
    }

    const topicsByCourse = {};
    if (topicsByCourseAggResult.status === "fulfilled") {
      topicsByCourseAggResult.value.forEach((row) => {
        if (!row?._id) return;
        topicsByCourse[String(row._id)] = Array.isArray(row.topics)
          ? row.topics.filter(Boolean).map((v) => String(v))
          : [];
      });
    } else {
      courses.forEach((course) => {
        topicsByCourse[course] = [];
      });
    }

    res.json({ courses, topics, topicsByCourse, difficulties, courseTitles });
  } catch (err) {
    console.error('metadata error', err);
    res.json({
      courses: [],
      topics: [],
      topicsByCourse: {},
      difficulties: [],
      courseTitles: {}
    });
  }
});

/* ==========================================
   GET RANDOM QUESTIONS
========================================== */

function parseLimitParam(rawLimit) {
  let limit = rawLimit;
  if (Array.isArray(limit)) limit = limit[0];
  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 10;
  return Math.min(50, safeLimit);
}

function parseBooleanParam(value) {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return false;
}

function isUsableOption(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized !== "" && normalized !== "n/a";
}

function isUsableQuestion(q) {
  const usableOptionCount = [
    q.option_a,
    q.option_b,
    q.option_c,
    q.option_d
  ].filter(isUsableOption).length;
  // allow:
  // - regular MCQ with at least two usable options (e.g., True/False)
  // - free-response records with no usable options
  // reject one-option broken records that cause poor rendering.
  return usableOptionCount === 0 || usableOptionCount >= 2;
}

function evaluateQuestionQuality(q) {
  const issues = [];
  let score = 100;

  const hasQuestion = String(q.question_latex || "").trim().length > 0;
  if (!hasQuestion) {
    issues.push("missing_question");
    score -= 60;
  }

  const hasCourse = String(q.course || "").trim().length > 0;
  if (!hasCourse) {
    issues.push("missing_course");
    score -= 25;
  }

  const hasTopic = String(q.topic || "").trim().length > 0;
  if (!hasTopic) {
    issues.push("missing_topic");
    score -= 15;
  }

  const correct = String(q.correct_option || "").trim().toUpperCase();
  if (!["A", "B", "C", "D"].includes(correct)) {
    issues.push("invalid_correct_option");
    score -= 20;
  }

  const usableOptionCount = [
    q.option_a,
    q.option_b,
    q.option_c,
    q.option_d
  ].filter(isUsableOption).length;

  if (usableOptionCount === 1) {
    issues.push("only_one_option");
    score -= 40;
  }

  if (usableOptionCount > 0 && ["A", "B", "C", "D"].includes(correct)) {
    const optionMap = {
      A: q.option_a,
      B: q.option_b,
      C: q.option_c,
      D: q.option_d
    };
    if (!isUsableOption(optionMap[correct])) {
      issues.push("correct_option_missing_text");
      score -= 25;
    }
  }

  if (!String(q.solution_latex || "").trim()) {
    issues.push("missing_solution");
    score -= 5;
  }

  score = Math.max(0, Math.min(100, score));
  return { qualityScore: score, qualityIssues: issues, needsReview: score < 70 || issues.length > 0 };
}

function prepareQuestionForInsert(q) {
  const quality = evaluateQuestionQuality(q);
  return { ...q, ...quality };
}

function pickBalancedByTopic(pool, limit, addFn) {
  const groups = new Map();
  pool.forEach((q) => {
    const topic = String(q.topic || "General");
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(q);
  });

  const topics = Array.from(groups.keys());
  topics.forEach((t) => {
    const list = groups.get(t);
    groups.set(t, list.sort(() => Math.random() - 0.5));
  });

  let cursor = 0;
  while (addFn.count() < limit && topics.length > 0) {
    const topic = topics[cursor % topics.length];
    const list = groups.get(topic) || [];
    if (!list.length) {
      groups.delete(topic);
      const idx = topics.indexOf(topic);
      if (idx >= 0) topics.splice(idx, 1);
      if (!topics.length) break;
      continue;
    }
    const q = list.pop();
    addFn(q);
    cursor += 1;
  }
}

async function pickQuestionsWithFallback({ filter, limit, excludedIds = new Set(), balanceTopics = false }) {
  const seen = new Set(excludedIds);
  const selected = [];

  const addQuestion = (q) => {
    const key = String(q._id || `${q.course}|${q.topic}|${q.question_latex}`);
    if (seen.has(key)) return;
    seen.add(key);
    if (!isUsableQuestion(q)) return;
    selected.push(q);
  };
  addQuestion.count = () => selected.length;

  const pickFromQuery = async (query, balanceTopics) => {
    if (selected.length >= limit) return;
    const pool = await Question.find(query).lean();
    const shuffled = pool.sort(() => Math.random() - 0.5);
    if (balanceTopics && !query.topic) {
      pickBalancedByTopic(shuffled, limit, addQuestion);
    } else {
      for (const q of shuffled) {
        addQuestion(q);
        if (selected.length >= limit) break;
      }
    }
  };

  await pickFromQuery(filter, balanceTopics);

  if (selected.length < limit && filter.difficulty) {
    const relaxed = { ...filter };
    delete relaxed.difficulty;
    await pickFromQuery(relaxed, balanceTopics);
  }

  if (selected.length < limit && filter.topic) {
    const relaxed = { ...filter };
    delete relaxed.topic;
    delete relaxed.difficulty;
    await pickFromQuery(relaxed, balanceTopics);
  }

  if (selected.length < limit && filter.course) {
    await pickFromQuery({ course: filter.course }, balanceTopics);
  }

  if (selected.length < limit) {
    await pickFromQuery({}, balanceTopics);
  }

  return selected.slice(0, limit);
}

app.get("/api/questions", authMiddleware, async (req, res) => {
  const { course, topic, difficulty } = req.query;
  const balanceTopics = parseBooleanParam(req.query?.balanceTopics);
  const limit = parseLimitParam(req.query?.limit);

  const filter = {};
  if (course) filter.course = course;
  if (topic) filter.topic = topic;
  if (difficulty) filter.difficulty = difficulty;

  let effectiveBalanceTopics = balanceTopics;
  if (!topic && course && !balanceTopics) {
    try {
      const topicsForCourse = await Question.distinct('topic', { course });
      if (Array.isArray(topicsForCourse) && topicsForCourse.length > 1) {
        effectiveBalanceTopics = true;
      }
    } catch (error) {
      console.error('auto-balance topics check failed:', error);
    }
  }

  const picked = await pickQuestionsWithFallback({ filter, limit, balanceTopics: effectiveBalanceTopics });
  const safePicked = picked.map((q) => {
    const { correct_option, ...safe } = q;
    return safe;
  });

  res.set("X-Questions-Requested", String(limit));
  res.set("X-Questions-Returned", String(safePicked.length));
  res.set("X-Questions-Fallback-Used", String(safePicked.length < limit ? "true" : "false"));
  res.json(safePicked);
});

/* ==========================================
   SMART REVIEW (WRONG ANSWERS PRIORITY)
========================================== */

app.get("/api/questions/review", authMiddleware, async (req, res) => {
  const { course, topic, difficulty } = req.query;
  const balanceTopics = parseBooleanParam(req.query?.balanceTopics);
  const limit = parseLimitParam(req.query?.limit);

  const questionMatch = {};
  if (course) questionMatch["question.course"] = course;
  if (topic) questionMatch["question.topic"] = topic;
  if (difficulty) questionMatch["question.difficulty"] = difficulty;

  const wrongQuestions = await QuizAttempt.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(req.user.id) } },
    { $unwind: "$answers" },
    { $match: { "answers.isCorrect": false } },
    {
      $group: {
        _id: "$answers.questionId",
        lastAttempt: { $max: "$createdAt" },
        wrongCount: { $sum: 1 }
      }
    },
    { $sort: { lastAttempt: -1, wrongCount: -1 } },
    { $limit: 200 },
    {
      $lookup: {
        from: "questions",
        localField: "_id",
        foreignField: "_id",
        as: "question"
      }
    },
    { $unwind: "$question" },
    ...(Object.keys(questionMatch).length ? [{ $match: questionMatch }] : []),
    {
      $project: {
        question: 1,
        wrongCount: 1,
        lastAttempt: 1
      }
    }
  ]);

  const picked = [];
  const excluded = new Set();

  for (const row of wrongQuestions) {
    const q = row.question;
    const key = String(q._id || `${q.course}|${q.topic}|${q.question_latex}`);
    if (excluded.has(key)) continue;
    if (!isUsableQuestion(q)) continue;
    excluded.add(key);
    picked.push(q);
    if (picked.length >= limit) break;
  }

  if (picked.length < limit) {
    const filter = {};
    if (course) filter.course = course;
    if (topic) filter.topic = topic;
    if (difficulty) filter.difficulty = difficulty;
    const topUp = await pickQuestionsWithFallback({
      filter,
      limit: limit - picked.length,
      excludedIds: excluded,
      balanceTopics
    });
    picked.push(...topUp);
  }

  const safePicked = picked.slice(0, limit).map((q) => {
    const { correct_option, ...safe } = q;
    return safe;
  });

  res.set("X-Questions-Requested", String(limit));
  res.set("X-Questions-Returned", String(safePicked.length));
  res.set("X-Questions-Smart-Review-Used", "true");
  res.json(safePicked);
});

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/[^\p{L}\p{N}\s.]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeComparableText(value) {
  return normalizeComparableText(value)
    .split(" ")
    .filter(Boolean);
}

function areAnswersEquivalent(correctRaw, selectedRaw) {
  const correctNormalized = normalizeComparableText(correctRaw);
  const selectedNormalized = normalizeComparableText(selectedRaw);

  if (!correctNormalized || !selectedNormalized) return false;

  const isMcqAnswer = /^[a-d]$/i.test(correctNormalized);
  if (isMcqAnswer) {
    return selectedNormalized.toUpperCase() === correctNormalized.toUpperCase();
  }

  if (selectedNormalized === correctNormalized) return true;

  // Numeric equivalence: tolerate commas/spacing differences.
  const correctNumber = Number(correctNormalized.replace(/,/g, ""));
  const selectedNumber = Number(selectedNormalized.replace(/,/g, ""));
  if (Number.isFinite(correctNumber) && Number.isFinite(selectedNumber)) {
    return correctNumber === selectedNumber;
  }

  // Substring tolerance for short free-response variants.
  if (
    correctNormalized.length >= 6 &&
    selectedNormalized.length >= 4 &&
    (correctNormalized.includes(selectedNormalized) || selectedNormalized.includes(correctNormalized))
  ) {
    return true;
  }

  // Token overlap tolerance for longer descriptive answers.
  const correctTokens = tokenizeComparableText(correctNormalized);
  const selectedTokens = tokenizeComparableText(selectedNormalized);
  if (correctTokens.length < 3 || selectedTokens.length < 2) return false;

  const correctTokenSet = new Set(correctTokens);
  const overlap = selectedTokens.filter((t) => correctTokenSet.has(t)).length;
  const requiredOverlap = Math.max(2, Math.ceil(correctTokens.length * 0.6));
  return overlap >= requiredOverlap;
}

/* ==========================================
   SUBMIT QUIZ + SAVE ATTEMPT
========================================== */

app.post("/api/submit", authMiddleware, async (req, res) => {
  const { answers, course, topic } = req.body;

  if (!answers || !Array.isArray(answers) || answers.length === 0)
    return res.status(400).json({ message: "Invalid answers format" });

  const uniqueAnswers = [
    ...new Map(answers.map(a => [a.questionId, a])).values()
  ];

  const questionIds = uniqueAnswers.map(a => a.questionId);

  const questions = await Question.find({ _id: { $in: questionIds } });

  const questionMap = {};
  questions.forEach(q => {
    questionMap[String(q._id)] = q.correct_option;
  });

  let score = 0;

  const detailedAnswers = uniqueAnswers.map(ans => {
    const questionId = String(ans.questionId);
    const correct = questionMap[questionId];
    const isCorrect = areAnswersEquivalent(correct, ans.selectedOption);
    if (isCorrect) score++;

    return {
      questionId,
      selectedOption: ans.selectedOption,
      correctOption: correct,
      isCorrect
    };
  });

  const percentage = ((score / uniqueAnswers.length) * 100).toFixed(2);
  const selectedCourse = String(course || "").trim() || getMostFrequentValue(questions.map((q) => q.course)) || "General";
  const selectedTopic = String(topic || "").trim() || getMostFrequentValue(questions.map((q) => q.topic)) || "Mixed Topics";

  await QuizAttempt.create({
    userId: req.user.id,
    score,
    total: uniqueAnswers.length,
    percentage,
    course: selectedCourse,
    topic: selectedTopic,
    answers: detailedAnswers
  });

  // return detailed answers so the client can render correctness without
  // needing to re-fetch anything
  res.json({ total: uniqueAnswers.length, score, percentage, detailedAnswers });
});

/* ==========================================
   STUDENT QUIZ HISTORY
========================================== */

app.get("/api/my-attempts", authMiddleware, async (req, res) => {
  const { page, limit, course, topic } = req.query || {};
  const hasAdvancedQuery =
    page !== undefined ||
    limit !== undefined ||
    Boolean(course) ||
    Boolean(topic);

  const filter = { userId: req.user.id };
  if (course) filter.course = course;
  if (topic && topic !== "All Topics") filter.topic = topic;

  if (!hasAdvancedQuery) {
    const attempts = await QuizAttempt.find(filter).sort({ createdAt: -1 }).lean();
    const enrichedAttempts = await enrichAttemptsWithInferredMetadata(attempts);
    return res.json(enrichedAttempts);
  }

  const safePage = parsePositiveInt(page, 1);
  const safeLimit = parsePositiveInt(limit, 20, 100);
  const skip = (safePage - 1) * safeLimit;

  const [attempts, total] = await Promise.all([
    QuizAttempt.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    QuizAttempt.countDocuments(filter)
  ]);
  const enrichedAttempts = await enrichAttemptsWithInferredMetadata(attempts);

  return res.json({
    attempts: enrichedAttempts,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit))
    }
  });
});

app.get("/api/admin/attempts",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const { page, limit, course, topic, username } = req.query || {};
      const safePage = parsePositiveInt(page, 1);
      const safeLimit = parsePositiveInt(limit, 25, 100);
      const skip = (safePage - 1) * safeLimit;

      const filter = {};
      if (course) filter.course = course;
      if (topic && topic !== "All Topics") filter.topic = topic;

      if (username) {
        const usernameRegex = new RegExp(escapeRegex(String(username).trim()), "i");
        const users = await User.find({ username: usernameRegex }).select("_id");
        const userIds = users.map((u) => u._id);
        if (!userIds.length) {
          return res.json({
            attempts: [],
            pagination: { page: safePage, limit: safeLimit, total: 0, totalPages: 1 }
          });
        }
        filter.userId = { $in: userIds };
      }

      const [attempts, total] = await Promise.all([
        QuizAttempt.find(filter)
          .populate("userId", "username")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(safeLimit)
          .lean(),
        QuizAttempt.countDocuments(filter)
      ]);
      const enrichedAttempts = await enrichAttemptsWithInferredMetadata(attempts);

      return res.json({
        attempts: enrichedAttempts,
        pagination: {
          page: safePage,
          limit: safeLimit,
          total,
          totalPages: Math.max(1, Math.ceil(total / safeLimit))
        }
      });
    } catch (error) {
      console.error("admin attempts error:", error);
      return res.status(500).json({ message: "Failed to fetch admin attempts" });
    }
  });

/* ==========================================
   ADMIN: QUESTION QUALITY REVIEW
========================================== */

app.get("/api/admin/questions/review",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const { page, limit, minScore, course, topic } = req.query || {};
      const safePage = parsePositiveInt(page, 1);
      const safeLimit = parsePositiveInt(limit, 25, 200);
      const scoreThreshold = Number.isFinite(Number(minScore)) ? Number(minScore) : 70;
      const skip = (safePage - 1) * safeLimit;

      const filter = {
        $or: [
          { needsReview: true },
          { qualityScore: { $lte: scoreThreshold } },
          { qualityIssues: { $exists: true, $ne: [] } }
        ]
      };
      if (course) filter.course = course;
      if (topic) filter.topic = topic;

      const [items, total] = await Promise.all([
        Question.find(filter).sort({ qualityScore: 1 }).skip(skip).limit(safeLimit).lean(),
        Question.countDocuments(filter)
      ]);

      return res.json({
        items,
        pagination: {
          page: safePage,
          limit: safeLimit,
          total,
          totalPages: Math.max(1, Math.ceil(total / safeLimit))
        }
      });
    } catch (error) {
      console.error("admin questions review error:", error);
      return res.status(500).json({ message: "Failed to fetch question review queue" });
    }
  });

app.post("/api/admin/questions/quality-scan",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const { course, topic, limit } = req.body || {};
      const safeLimit = parsePositiveInt(limit, 500, 2000);

      const filter = {};
      if (course) filter.course = course;
      if (topic) filter.topic = topic;

      const targets = await Question.find(filter).limit(safeLimit).lean();
      let updated = 0;

      for (const q of targets) {
        const quality = evaluateQuestionQuality(q);
        await Question.updateOne(
          { _id: q._id },
          { $set: quality }
        );
        updated += 1;
      }

      return res.json({ updated, scanned: targets.length });
    } catch (error) {
      console.error("admin quality scan error:", error);
      return res.status(500).json({ message: "Failed to scan question quality" });
    }
  });

/* ==========================================
   LEADERBOARD (TOP 10 BY AVG SCORE)
========================================== */

function getWeeklyWindowUtc(now = new Date()) {
  const todayUtc = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));
  const day = todayUtc.getUTCDay(); // 0 (Sun) - 6 (Sat)
  const diffToMonday = (day + 6) % 7;
  const start = new Date(todayUtc);
  start.setUTCDate(todayUtc.getUTCDate() - diffToMonday);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start, end };
}

app.get("/api/leaderboard", async (req, res) => {
  const season = String(req.query?.season || "all").toLowerCase();
  let match = {};
  let windowStart = null;
  let windowEnd = null;

  if (season === "weekly") {
    const window = getWeeklyWindowUtc();
    windowStart = window.start;
    windowEnd = window.end;
    match = { createdAt: { $gte: windowStart, $lt: windowEnd } };
  }

  const pipeline = [];
  if (Object.keys(match).length) pipeline.push({ $match: match });
  pipeline.push(
    {
      $addFields: {
        percentageNumber: {
          $cond: [
            { $isNumber: "$percentage" },
            "$percentage",
            {
              $toDouble: {
                $replaceAll: {
                  input: { $toString: "$percentage" },
                  find: "%",
                  replacement: ""
                }
              }
            }
          ]
        }
      }
    },
    {
      $group: {
        _id: "$userId",
        avgScore: { $avg: "$percentageNumber" },
        attempts: { $sum: 1 }
      }
    },
    { $sort: { avgScore: -1, attempts: -1 } },
    { $limit: 10 },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "user"
      }
    },
    { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        avgScore: 1,
        attempts: 1,
        username: "$user.username"
      }
    }
  );

  try {
    const leaderboard = await QuizAttempt.aggregate(pipeline);
    const withBadges = leaderboard.map((entry, index) => {
      let badge = "";
      if (index === 0) badge = "gold";
      if (index === 1) badge = "silver";
      if (index === 2) badge = "bronze";
      return { ...entry, rank: index + 1, badge };
    });

    if (windowStart && windowEnd) {
      res.set("X-Leaderboard-Season", "weekly");
      res.set("X-Leaderboard-Start", windowStart.toISOString());
      res.set("X-Leaderboard-End", windowEnd.toISOString());
    } else {
      res.set("X-Leaderboard-Season", "all");
    }

    res.json(withBadges);
  } catch (error) {
    console.error("leaderboard error:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

/* ==========================================
   FILE UPLOAD (AUTHENTICATED USERS)
========================================== */

const upload = multer({ storage: multer.memoryStorage() });

app.post(["/api/upload-pdf", "/api/upload-file"],
  authMiddleware,
  upload.single("file"),
  async (req, res) => {

    if (!req.file)
      return res.status(400).json({ message: "No file uploaded" });

    const uploadKind = resolveUploadKind(req.file);
    if (!uploadKind.allowed) {
      return res.status(400).json({
        message: "Only valid PDF/JPG/PNG/WEBP/GIF/HEIC files are allowed"
      });
    }

    if (!hasCloudinaryConfig) {
      return res.status(500).json({
        message: "Upload service is not configured. Set CLOUDINARY_URL or CLOUDINARY_* env vars."
      });
    }

    try {
      const uploadResult = await uploadFileToCloudinary(
        req.file.buffer,
        req.file.originalname,
        uploadKind.normalizedMimeType
      );

      await PdfUpload.create({
        userId: req.user.id,
        filename: uploadResult.public_id,
        originalname: req.file.originalname,
        fileUrl: uploadResult.secure_url,
        cloudinaryPublicId: uploadResult.public_id,
        mimeType: uploadKind.normalizedMimeType,
        resourceType: uploadResult.resource_type
      });

      res.json({
        message: "File uploaded and pending review",
        url: uploadResult.secure_url,
        mimeType: uploadKind.normalizedMimeType,
        resourceType: uploadResult.resource_type
      });
    } catch (error) {
      console.error("Cloudinary upload failed:", error);
      res.status(500).json({ message: "Failed to upload file" });
    }
});

/* ==========================================
   STUDENT VIEW THEIR UPLOADS
========================================== */

app.get("/api/my-uploads",
  authMiddleware,
  async (req, res) => {
    try {
      const uploads = await PdfUpload.find({
        userId: req.user.id
      }).sort({ createdAt: -1 });

      res.json(uploads);
    } catch (error) {
      console.error("my-uploads error:", error);
      res.status(500).json({ message: "Failed to fetch uploads" });
    }
});

/* ==========================================
   ADMIN VIEW ALL UPLOADS
========================================== */

app.get("/api/admin/uploads",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const uploads = await PdfUpload.find()
        .populate("userId", "username")
        .sort({ createdAt: -1 });

      res.json(uploads);
    } catch (error) {
      console.error("admin/uploads error:", error);
      res.status(500).json({ message: "Failed to fetch admin uploads" });
    }
});

/* ==========================================
   ADMIN APPROVE / REJECT UPLOAD
========================================== */

app.patch("/api/admin/uploads/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const { status } = req.body;

      if (!["approved", "rejected"].includes(status))
        return res.status(400).json({ message: "Invalid status" });

      await PdfUpload.findByIdAndUpdate(req.params.id, { status });

      res.json({ message: `Upload ${status}` });
    } catch (error) {
      console.error("admin patch upload error:", error);
      res.status(500).json({ message: "Failed to update upload status" });
    }
});

app.delete("/api/admin/uploads/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const uploadId = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(uploadId)) {
        return res.status(400).json({ message: "Invalid upload id" });
      }

      const uploadDoc = await PdfUpload.findById(uploadId);
      if (!uploadDoc) {
        return res.status(404).json({ message: "Upload not found" });
      }

      if (hasCloudinaryConfig && uploadDoc.cloudinaryPublicId) {
        const deleteResourceType = uploadDoc.resourceType || "image";
        try {
          await deleteFileFromCloudinary(uploadDoc.cloudinaryPublicId, deleteResourceType);
        } catch (deleteErr) {
          // Fallback for legacy records where resource type may be mismatched.
          if (deleteResourceType !== "raw") {
            try {
              await deleteFileFromCloudinary(uploadDoc.cloudinaryPublicId, "raw");
            } catch {
              console.error("cloudinary delete failed:", deleteErr);
            }
          } else {
            console.error("cloudinary delete failed:", deleteErr);
          }
        }
      }

      await PdfUpload.findByIdAndDelete(uploadId);
      return res.json({ message: "Upload deleted" });
    } catch (error) {
      console.error("admin delete upload error:", error);
      return res.status(500).json({ message: "Failed to delete upload" });
    }
  });

/* ==========================================
   ADMIN STATS
========================================== */

app.get("/api/admin/stats",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const totalUsers = await User.countDocuments();
      const totalQuestions = await Question.countDocuments();
      const totalAttempts = await QuizAttempt.countDocuments();
      const totalUploads = await PdfUpload.countDocuments();

      res.json({
        totalUsers,
        totalQuestions,
        totalAttempts,
        totalUploads
      });
    } catch (error) {
      console.error("admin stats error:", error);
      res.status(500).json({ message: "Failed to fetch admin stats" });
    }
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  return res.status(500).json({ message: "Internal Server Error" });
});

/* ==========================================
   START SERVER
========================================== */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

