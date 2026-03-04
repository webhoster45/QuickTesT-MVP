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
  solution_latex: String
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
    const fileName = req.body?.fileName || "questionsmvp.json";
    const filePath = path.join(__dirname, fileName);

    const rawData = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    let allQuestions = [];

    if (Array.isArray(rawData)) {
      allQuestions = rawData;
    } else {
      for (let key in rawData) {
        // attach the top‑level key as courseTitle if present; preserves the
        // human‑readable title that some datasets use.
        const arr = rawData[key].map((q) => ({ ...q, courseTitle: key }));
        allQuestions = allQuestions.concat(arr);
      }
    }

    let inserted = 0;
    let skipped = 0;

    for (let q of allQuestions) {
      try {
        await Question.create(q);
        inserted++;
      } catch {
        skipped++;
      }
    }

    res.json({ inserted, skipped });

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
    const courses = await Question.distinct('course');
    const topics = await Question.distinct('topic');
    const difficulties = await Question.distinct('difficulty');
    // build map of course->title when available
    const titleAgg = await Question.aggregate([
      { $match: { courseTitle: { $exists: true, $ne: null } } },
      { $group: { _id: '$course', title: { $first: '$courseTitle' } } }
    ]);
    const courseTitles = {};
    titleAgg.forEach((r) => {
      if (r._id) courseTitles[r._id] = r.title;
    });

    // also precompute topic lists grouped by course so the UI can scope the
    // dropdown without having to fetch a full question set.
    const topicsByCourse = {};
    for (const c of courses) {
      topicsByCourse[c] = await Question.distinct('topic', { course: c });
    }
    res.json({ courses, topics, topicsByCourse, difficulties, courseTitles });
  } catch (err) {
    console.error('metadata error', err);
    res.status(500).json({ message: 'Failed to fetch metadata' });
  }
});

/* ==========================================
   GET RANDOM QUESTIONS
========================================== */

app.get("/api/questions", authMiddleware, async (req, res) => {
  let { course, topic, difficulty, limit } = req.query;

  limit = parseInt(limit) || 10;

  // Prevent abuse
  if (limit > 50) limit = 50;

  const filter = {};
  if (course) filter.course = course;
  if (topic) filter.topic = topic;
  if (difficulty) filter.difficulty = difficulty;

  const questions = await Question.aggregate([
    { $match: filter },
    { $sample: { size: limit } },
    // do not expose correct_option; solutions may be shown after submission
    { $project: { correct_option: 0 } }
  ]);

  res.json(questions);
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

  await QuizAttempt.create({
    userId: req.user.id,
    score,
    total: uniqueAnswers.length,
    percentage,
    course,
    topic,
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
  const attempts = await QuizAttempt.find({ userId: req.user.id })
    .sort({ createdAt: -1 });

  res.json(attempts);
});

/* ==========================================
   LEADERBOARD (TOP 10 BY AVG SCORE)
========================================== */

app.get("/api/leaderboard", async (req, res) => {
  // aggregate average percentages per user and pull username for display
  const leaderboard = await QuizAttempt.aggregate([
    {
      $group: {
        _id: "$userId",
        avgScore: { $avg: "$percentage" }
      }
    },
    { $sort: { avgScore: -1 } },
    { $limit: 10 },
    // lookup user document to get username
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
        username: "$user.username"
      }
    }
  ]);

  res.json(leaderboard);
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
