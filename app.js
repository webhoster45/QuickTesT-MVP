// ==========================================
// QuickTest Backend - Structured MVP v3
// Admin Secret + Quiz History + PDF Workflow
// ==========================================
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const cors=require("cors");

const app = express();
app.use(express.json());
app.use(cors('*'))

// serve uploaded PDF files so frontend can download them
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// explicit download route (fallback for some environments)
app.get('/uploads/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error('sendFile error for', filePath, err && err.code);
      return res.status(404).send('Not found');
    }
  });
});

/* ==========================================
   CONFIG
========================================== */

const PORT =process.env.PORT|| 5000;


mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.error("MongoDB Error:", err));

/* ==========================================
   SCHEMAS
========================================== */

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  isAdmin: { type: Boolean, default: false }
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

/* ==========================================
   REGISTER (ONE ADMIN ONLY)
========================================== */

app.post("/api/register", async (req, res) => {
  try {
    const { username, password, adminSecret } = req.body;

    if (!username || !password)
      return res.status(400).json({ message: "Username and password required" });

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

    await User.create({ username, password: hashedPassword, isAdmin });

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

  const user = await User.findOne({ username });
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
    questionMap[q._id] = q.correct_option;
  });

  let score = 0;

  const detailedAnswers = uniqueAnswers.map(ans => {
    const correct = questionMap[ans.questionId];
    const isCorrect = correct === ans.selectedOption;
    if (isCorrect) score++;

    return {
      questionId: ans.questionId,
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
   PDF UPLOAD (AUTHENTICATED USERS)
========================================== */

const upload = multer({ dest: "uploads/" });

app.post("/api/upload-pdf",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {

    if (!req.file)
      return res.status(400).json({ message: "No file uploaded" });

    await PdfUpload.create({
      userId: req.user.id,
      filename: req.file.filename,
      originalname: req.file.originalname
    });

    // log and return a download URL to help frontend debugging
    const downloadUrl = `/uploads/${req.file.filename}`;
    console.log('Uploaded PDF:', {
      filename: req.file.filename,
      originalname: req.file.originalname,
      downloadUrl,
      savedAt: path.join(__dirname, 'uploads', req.file.filename)
    });

    res.json({ message: "PDF uploaded and pending review", url: downloadUrl });
});

/* ==========================================
   STUDENT VIEW THEIR UPLOADS
========================================== */

app.get("/api/my-uploads",
  authMiddleware,
  async (req, res) => {

    const uploads = await PdfUpload.find({
      userId: req.user.id
    }).sort({ createdAt: -1 });

    res.json(uploads);
});

/* ==========================================
   ADMIN VIEW ALL UPLOADS
========================================== */

app.get("/api/admin/uploads",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {

    const uploads = await PdfUpload.find()
      .populate("userId", "username")
      .sort({ createdAt: -1 });

    res.json(uploads);
});

/* ==========================================
   ADMIN APPROVE / REJECT UPLOAD
========================================== */

app.patch("/api/admin/uploads/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {

    const { status } = req.body;

    if (!["approved", "rejected"].includes(status))
      return res.status(400).json({ message: "Invalid status" });

    await PdfUpload.findByIdAndUpdate(req.params.id, { status });

    res.json({ message: `Upload ${status}` });
});

/* ==========================================
   ADMIN STATS
========================================== */

app.get("/api/admin/stats",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {

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
});

/* ==========================================
   START SERVER
========================================== */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});