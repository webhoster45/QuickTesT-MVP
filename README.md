# QuickTest Backend

Express + MongoDB backend for quiz delivery, scoring, leaderboard, and PDF upload/review workflows.

## Stack
- Node.js (CommonJS)
- Express 5
- MongoDB + Mongoose
- JWT auth
- bcrypt password hashing
- Multer memory upload middleware
- Cloudinary raw file upload API

## Project Files
- `app.js`: Entire server, models, middleware, and routes
- `question-banks/`: Folder containing per-course JSON files (one file per bank)
- `.env`: Runtime secrets/config

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

## Boot Flow (`app.js`)
1. Loads `.env` with `dotenv`.
2. Sets DNS resolvers (`8.8.8.8`, `1.1.1.1`).
3. Creates Express app and enables JSON body parsing + CORS.
4. Serves `/uploads` static folder.
5. Adds fallback `/uploads/*requestedPath` route:
   - If local file exists in `uploads/`, serves it.
   - Else checks `PdfUpload` document by `filename` or `cloudinaryPublicId`.
   - If found, redirects to `fileUrl` (Cloudinary URL).
   - Else returns `404`.
6. Parses Cloudinary config from split vars or `CLOUDINARY_URL`.
7. Connects Mongoose to `MONGO_URI`.
8. Registers schemas/models.
9. Registers auth/admin middleware.
10. Registers API routes.
11. Starts server with `app.listen(PORT)`.

## Data Models
### User
- `username` (unique, required)
- `password` (hashed, required)
- `isAdmin` (default `false`)
- timestamps

### Question
- `course`, `topic`, `question_latex`, `correct_option`, `difficulty` required
- options A-D and `solution_latex` optional
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

## Cloudinary Upload Internals
`uploadPdfToCloudinary(fileBuffer, originalname)`:
1. Builds normalized file name and unique `public_id`.
2. Builds Cloudinary signed payload (`folder`, `public_id`, `timestamp`).
3. Creates SHA1 signature using API secret.
4. Sends multipart request to `https://api.cloudinary.com/v1_1/<cloud>/raw/upload`.
5. Returns Cloudinary JSON or throws on failed response.

## API Reference

### Public/General
#### `GET /uploads/<path>`
- Local file or Cloudinary redirect fallback.
- Responses: `200` (local), `302` (redirect), `404`.

#### `GET /api/leaderboard`
- Top 10 users by average percentage.
- Uses Mongo aggregation + user lookup.

#### `GET /api/health`
- Lightweight health probe for uptime/deployment checks.

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
- Imports all JSON files from `question-banks/` by default.
- Optional body: `{ "fileName": "CHM_101_General_Chemistry.json" }` to import one file.
- Supports array JSON and object-of-arrays format.
- Inserts questions; duplicates are skipped.
Response:
```json
{ "inserted": 0, "skipped": 0, "sourceFiles": ["..."] }
```

#### `GET /api/metadata` (auth)
Returns distinct:
- `courses`
- `topics`
- `topicsByCourse`
- `difficulties`
- `courseTitles` map (if present in imported data)

#### `GET /api/questions` (auth)
Query params:
- `course`
- `topic`
- `difficulty`
- `limit` (default `10`, max `50`)
Behavior:
- Random samples with `$sample`.
- Excludes `correct_option` from response.

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
Response includes `total`, `score`, `percentage`, `detailedAnswers`.

#### `GET /api/my-attempts` (auth)
- Without query params: returns array of attempts (backward-compatible).
- With query params (`page`, `limit`, `course`, `topic`): returns
  `{ attempts, pagination }`.

#### `GET /api/admin/attempts` (admin)
- Admin history listing with optional query params:
  - `page`, `limit`
  - `course`, `topic`
  - `username` (case-insensitive partial match)
- Returns:
```json
{
  "attempts": [],
  "pagination": { "page": 1, "limit": 25, "total": 0, "totalPages": 1 }
}
```

### File Workflow (PDF + Images)
#### `POST /api/upload-pdf` or `POST /api/upload-file` (auth)
- Multipart form field: `file`
- Allowed mime types: `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `image/gif`
- Requires Cloudinary config
- Uploads file to Cloudinary and saves DB record as `pending`
Response:
```json
{
  "message": "File uploaded and pending review",
  "url": "https://...",
  "mimeType": "application/pdf",
  "resourceType": "image"
}
```

#### `GET /api/my-uploads` (auth)
- User sees their own uploaded PDFs.

#### `GET /api/admin/uploads` (admin)
- Admin sees all uploads with uploader username.

#### `PATCH /api/admin/uploads/:id` (admin)
Body:
```json
{ "status": "approved" }
```
- Allowed values: `approved`, `rejected`

#### `GET /api/admin/stats` (admin)
Returns totals:
- users
- questions
- attempts
- uploads

## Local Run
```bash
npm install
node app.js
```

## Pre-Push Verification (Executed)
Date tested: 2026-03-03

### Passed
- Server boot + DB connection
- `POST /api/register` (user)
- `POST /api/login` (user)
- Unauthorized guard on `GET /api/questions` (`401`)
- `GET /api/metadata`
- `GET /api/questions` (authorized)
- `POST /api/submit`
- `GET /api/my-attempts`
- `GET /api/leaderboard`
- `POST /api/upload-pdf`
- `GET /api/my-uploads`
- `GET /uploads/<cloudinaryPublicId>` returns `302` redirect
- Admin endpoints reject non-admin token (`403`)

### Blocked (needs real admin credentials)
- `POST /api/import` success path
- `GET /api/admin/uploads` success path
- `PATCH /api/admin/uploads/:id` success path
- `GET /api/admin/stats` success path

Reason: an admin already exists in the database, so a new admin cannot be created by design, and existing admin credentials were not available in-session.

## Known Notes
- Express 5 requires named wildcard route syntax; `/uploads/*requestedPath` is the compatible form.
- Upload endpoint validates mime type but does not inspect PDF binary signature.
- `percentage` is stored as a string (because of `toFixed(2)`) though used numerically in leaderboard aggregation.
- To add a new course bank, create a new `.json` file in `question-banks/`.
  On next `/api/import` (or startup sync), it will be auto-discovered and imported.
