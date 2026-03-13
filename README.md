# QuickTest Backend

QuickTest is a quiz platform backend that powers course discovery, quiz generation, scoring, history, leaderboard, and file uploads. It is designed for an MVP workflow where questions are maintained in JSON banks and imported into MongoDB.

## Architecture Overview
The backend is a single Express app with MongoDB for persistence. Requests are authenticated with JWT, and all quiz-related endpoints require a valid token. Admin-only endpoints handle question import, quality review, stats, and uploads moderation.

High-level flow:
- Questions live in `question-banks/` JSON files.
- Admin calls `/api/import` to insert them into MongoDB.
- Users fetch metadata and randomized questions, submit answers, and view results/history.

## Folder Structure
- `app.js`: Server, models, middleware, and all routes
- `question-banks/`: Per-course JSON banks
- `uploads/`: Local upload fallback directory
- `.env`: Runtime configuration

## Environment Variables
Required:
- `MONGO_URI`: MongoDB connection string
- `JWT_SECRET`: JWT signing secret
- `ADMIN_SECRET`: Secret required to create the one allowed admin account
- `PORT`: Optional, defaults to `5000`

Cloudinary (choose one approach):
- `CLOUDINARY_URL=cloudinary://<API_KEY>:<API_SECRET>@<CLOUD_NAME>`
- or split vars:
  - `CLOUDINARY_CLOUD_NAME`
  - `CLOUDINARY_API_KEY`
  - `CLOUDINARY_API_SECRET`

## Running Locally
```bash
npm install
node app.js
```

## Question Banks
Each file in `question-banks/` is a JSON array of question objects:
```json
[
  {
    "course": "CST 101",
    "topic": "Computer Overview",
    "question_latex": "What is a computer?",
    "option_a": "...",
    "option_b": "...",
    "option_c": "...",
    "option_d": "...",
    "correct_option": "B",
    "difficulty": "easy",
    "solution_latex": "..."
  }
]
```
Notes:
- `course`, `topic`, `question_latex`, `correct_option`, `difficulty` are required.
- The unique index is `{ course, topic, question_latex }`, so duplicates are skipped.
- LaTeX is supported in `question_latex` and `solution_latex`.

## Data Models
### User
- `username` (unique, required)
- `password` (hashed, required)
- `isAdmin` (default `false`)
- timestamps

### Question
- Required: `course`, `topic`, `question_latex`, `correct_option`, `difficulty`
- Optional: `option_a` - `option_d`, `solution_latex`
- Quality fields: `qualityScore`, `qualityIssues[]`, `needsReview`
- timestamps

### QuizAttempt
- `userId`, `score`, `total`, `percentage`, `course`, `topic`
- `answers[]` with `questionId`, `selectedOption`, `correctOption`, `isCorrect`
- timestamps

### PdfUpload
- `userId`, `filename`, `originalname`, `fileUrl`, `cloudinaryPublicId`
- `status`: `pending | approved | rejected`
- timestamps

## Core Features
### Question Generation
- `/api/questions` returns random questions with dedupe.
- If a filter has too few questions, it tops up by relaxing filters until the count is met.
- `balanceTopics=true` spreads questions across topics when no topic is specified.

### Smart Review
- `/api/questions/review` prioritizes questions the user missed before.
- If there are not enough wrong questions, it tops up with regular ones.

### Scoring
- `/api/submit` deduplicates answers and computes score and percentage.
- Returns `detailedAnswers` for rich client-side results views.

### Leaderboard
- `/api/leaderboard` returns top 10 by average percentage.
- `season=weekly` resets to the current week and adds `rank` + `badge`.

### Question Quality Review
- `/api/admin/questions/review` lists low-quality questions.
- `/api/admin/questions/quality-scan` recalculates quality metrics.

### Uploads
- Users can upload PDFs and images.
- `/uploads/*` serves local files or redirects to Cloudinary URLs.

## API Reference
### Auth
- `POST /api/register`
- `POST /api/login`
- `POST /api/forgot-password`
- `POST /api/reset-password`

### Questions
- `POST /api/import` (admin)
- `GET /api/metadata`
- `GET /api/questions`
- `GET /api/questions/review`
- `POST /api/submit`
- `GET /api/my-attempts`

### Admin
- `GET /api/admin/attempts`
- `GET /api/admin/questions/review`
- `POST /api/admin/questions/quality-scan`
- `GET /api/admin/uploads`
- `PATCH /api/admin/uploads/:id`
- `DELETE /api/admin/uploads/:id`
- `GET /api/admin/stats`

### Misc
- `GET /api/leaderboard`
- `GET /api/health`

## Troubleshooting
- If `/api/import` inserts `0`, the questions are likely duplicates already in MongoDB.
- If `metadata` is empty, run admin sync to import question banks.
- If uploads return `404`, check Cloudinary credentials and `uploads/` fallback.

## Deployment Notes
Make sure the same `.env` values are set in your host (Vercel or other). The backend relies on MongoDB being reachable at all times for metadata, quizzes, and leaderboard.
