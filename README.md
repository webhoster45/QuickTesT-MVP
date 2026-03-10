# QuickTest Backend

Express + MongoDB backend for quiz delivery, scoring, leaderboard, and upload moderation.

## Stack
- Node.js (CommonJS)
- Express
- MongoDB + Mongoose
- JWT auth
- bcrypt password hashing
- Multer memory upload middleware
- Cloudinary upload API

## Project Files
- `app.js`: Server, models, middleware, and routes
- `question-banks/`: Per-course JSON files (one file per bank)
- `.env`: Runtime config

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

## Data Models
### User
- `username` (unique, required)
- `password` (hashed, required)
- `isAdmin` (default `false`)
- timestamps

### Question
- `course`, `topic`, `question_latex`, `correct_option`, `difficulty` required
- options A-D and `solution_latex` optional
- `qualityScore`, `qualityIssues[]`, `needsReview`
- timestamps
- unique index on `{ course, topic, question_latex }` to prevent duplicates

### QuizAttempt
- `userId`
- `score`, `total`, `percentage`
- `course`, `topic`
- `answers[]` containing:
  - `questionId`
  - `selectedOption`
  - `correctOption`
  - `isCorrect`
- timestamps

### PdfUpload
- `userId`
- `filename`
- `originalname`
- `fileUrl`
- `cloudinaryPublicId`
- `status`: `pending | approved | rejected` (default `pending`)
- timestamps

## Middleware
### `authMiddleware`
- Reads bearer token from `Authorization: Bearer <token>`
- Verifies with `JWT_SECRET`
- Sets `req.user`
- Returns `401` for missing/invalid token

### `adminMiddleware`
- Loads requesting user from DB using `req.user.id`
- Requires `isAdmin === true`
- Returns `403` if not admin

## Question Bank Import
- Default import reads every `.json` file in `question-banks/`.
- Optional body: `{ "fileName": "CHM_101_General_Chemistry.json" }` to import one file.
- Supports array JSON or object-of-arrays format.
- Duplicates skipped due to the unique index.
- Each imported question is scored for quality and flagged if needed.

## API Reference

### Public/General
#### `GET /uploads/<path>`
- Local file or Cloudinary redirect fallback.
- Responses: `200` (local), `302` (redirect), `404`.

#### `GET /api/health`
- Lightweight health probe for uptime/deployment checks.

#### `GET /api/leaderboard`
- Default: all-time top 10 by average percentage.
- Query: `season=weekly` for weekly reset.
- Response includes `rank` and `badge` (gold/silver/bronze for top 3).

### Auth
#### `POST /api/register`
Body:
```json
{ "username": "user1", "password": "secret", "adminSecret": "optional" }
```
Behavior:
- If `adminSecret` provided, must match `ADMIN_SECRET`.
- Only one admin can ever be created.
- Hashes password with bcrypt.
Responses:
- `200` success
- `400` missing fields / duplicate username
- `403` invalid admin secret or admin already exists

#### `POST /api/login`
Body:
```json
{ "username": "user1", "password": "secret" }
```
Response:
```json
{ "token": "<jwt>", "isAdmin": false }
```
Errors: `400` invalid credentials.

### Questions/Quiz
#### `POST /api/import` (admin)
Imports all JSON files from `question-banks/` by default.
Response:
```json
{ "inserted": 0, "skipped": 0, "sourceFiles": ["..."] }
```

#### `GET /api/metadata` (auth)
Returns:
- `courses`, `topics`, `topicsByCourse`, `difficulties`, `courseTitles`

#### `GET /api/questions` (auth)
Query params:
- `course`
- `topic`
- `difficulty`
- `limit` (default `10`, max `50`)
- `balanceTopics=true` (optional)

Behavior:
- Random selection with dedupe and cleanup.
- If a filter has too few questions, the backend tops up by relaxing filters
  until the requested count is met.
- Excludes `correct_option` from response.

#### `GET /api/questions/review` (auth)
Smart Review mode.
- Prioritizes questions you previously missed.
- Supports the same query params as `/api/questions` (including `balanceTopics`).
- Tops up with regular questions if not enough wrong answers exist.

#### `POST /api/submit` (auth)
Body:
```json
{
  "course": "mathematics",
  "topic": "algebra",
  "answers": [
    { "questionId": "...", "selectedOption": "A" }
  ]
}
```
Behavior:
- Deduplicates answers by `questionId`.
- Computes score and percentage.
- Stores detailed attempt.
- If request body omits `course`/`topic`, backend infers them from submitted IDs.
Response includes `total`, `score`, `percentage`, `detailedAnswers`.

#### `GET /api/my-attempts` (auth)
- Without query params: returns array of attempts (backward-compatible).
- With query params (`page`, `limit`, `course`, `topic`): returns
  `{ attempts, pagination }`.

### Admin: Question Quality
#### `GET /api/admin/questions/review`
- Returns low-quality questions for review.
- Query: `page`, `limit`, `minScore`, `course`, `topic`.

#### `POST /api/admin/questions/quality-scan`
- Recomputes `qualityScore`, `qualityIssues`, `needsReview` on existing questions.
- Body supports `course`, `topic`, `limit`.

### Admin: Attempts, Uploads, Stats
- `GET /api/admin/attempts`
- `GET /api/admin/uploads`
- `PATCH /api/admin/uploads/:id`
- `DELETE /api/admin/uploads/:id`
- `GET /api/admin/stats`

## Notes
- Uploads accept PDFs and common image formats.
- The download route supports local files and Cloudinary-backed uploads.
