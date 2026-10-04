# Learning MCQ integration

All paths below use the existing `/api/v1` prefix. Quiz and attempt routes require `Authorization: Bearer <accessToken>`. Admin routes also require the admin role.

Admin creates/updates `/learnings` with the existing multipart image/title/description form and a `questions` field containing a JSON array. Each question has optional `_id` (preserve when editing), `question`, four `options` (`id`, `text`), `correctOptionId`, and optional `explanation`. An empty array removes the quiz. Omitting questions on update preserves the existing quiz. Question changes increment `quizVersion`.

Full `/learnings` and `/learning` records now require admin authentication because they include answer keys. Public clients must use `/learning-materials`; its existing response fields remain, with `mcq_count` and `quiz_version` added. No answer keys appear in that feed.

## User app

1. Load `/learning-materials` and `/learning-materials/:id` for published learning content.
2. Load `GET /learning-materials/:id/quiz` to receive `data: { learningId, quizVersion, questions: [{ _id, question, options: [{ id, text }] }] }`.
3. Submit all questions once in the request body to `POST /learning-materials/:id/attempts`:

```json
{
  "quizVersion": 1,
  "answers": [{ "questionId": "<question _id>", "optionId": "B" }]
}
```

The server derives user identity from the token and computes the score. A successful 201 response returns the stored attempt, including `score`, `totalQuestions`, `answers` with selected/correct IDs, correctness and explanations, and `createdAt`. A 409 means the quiz changed: reload it and restart. Invalid, incomplete, duplicate or unknown answers return 400. Retries create separate attempts.

4. `GET /learning-materials/:id/attempts/me?page=1&limit=10` returns only the authenticated user's attempts in `data: { attempts, pagination }`.

## Admin

- `GET /admin/learnings/:id/attempts`: paginated summaries populated with user name/email. Filters: `search`, `from`, `to` (ISO dates; date-only end dates include that UTC day).
- `GET /admin/learning-attempts/:attemptId`: full submission with snapshot answers and user name/email.
- `GET /admin/users/:userId/learning-attempts`: paginated history for one user.

Admin Learning cards include View Answers, name/email and date filters, pagination, and a question-by-question detail view. Each submission has a unique ID and timestamp. Historical attempts preserve learning title, quiz version and question/option/answer snapshots, including when learning content changes or is deleted.

Existing learning documents need no migration: questions default to an empty array and quizVersion to 1. User model is unchanged. The separate user app is outside this repository and must implement the screens using the contract above.
