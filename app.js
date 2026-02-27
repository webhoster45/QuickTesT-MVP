// ==========================================
// QuickTest Backend - Structured MVP v3
// Admin Secret + Quiz History + PDF Workflow
// ==========================================

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const app = express();
app.use(express.json());

/* ==========================================
   CONFIG
========================================== */

const PORT = 5000;
const JWT_SECRET = "super_secret_key_change_this";
const ADMIN_SECRET = "Gbemisolaismymum";
const MONGO_URI = "mongodb://127.0.0.1:27017/quicktest";

mongoose.connect(MONGO_URI)
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

  } catch {
    res.status(400).json({ message: "User already exists" });
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
    const filePath = path.join(__dirname, "questions.json");
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    let inserted = 0;
    let skipped = 0;

    for (let q of data) {
      try {
        await Question.create(q);
        inserted++;
      } catch {
        skipped++;
      }
    }

    res.json({ inserted, skipped });
  } catch {
    res.status(500).json({ message: "Import failed" });
  }
});

/* ==========================================
   GET RANDOM QUESTIONS
========================================== */

app.get("/api/questions", authMiddleware, async (req, res) => {
  const { course, topic, difficulty, limit} = req.query;

  const filter = {};
  if (course) filter.course = course;
  if (topic) filter.topic = topic;
  if (difficulty) filter.difficulty = difficulty;

  const questions = await Question.aggregate([
    { $match: filter },
    { $sample: { size: parseInt(limit) } },
    { $project: { correct_option: 0, solution_latex: 0 } }
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

  res.json({ total: uniqueAnswers.length, score, percentage });
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
  const leaderboard = await QuizAttempt.aggregate([
    {
      $group: {
        _id: "$userId",
        avgScore: { $avg: "$percentage" }
      }
    },
    { $sort: { avgScore: -1 } },
    { $limit: 10 }
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

    res.json({ message: "PDF uploaded and pending review" });
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