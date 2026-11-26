# HACKMIND AI — Firestore Zero-Trust Security Specification

## 1. Data Invariants
1. **Admin Authority Isolation**: Users cannot self-assign `admin` privileges via `/users/{userId}` or any client-writable collection. Admin access requires either an entry in `/admins/{uid}` (no client writes allowed) or the verified bootstrap administrator email (`admin@example.test` with `email_verified == true`).
2. **PII Split-Collection Isolation**: Email addresses and private consent preferences live exclusively in `/users/{userId}/private/{docId}` and are readable/writable only by the owner or verified admin. `/users/{userId}` contains zero PII.
3. **Email Verification Gate**: All standard write operations require `request.auth != null && request.auth.token.email_verified == true`.
4. **Immutable Ownership & Timestamps**: `organizerId`, `ownerId`, `userId`, `judgeId`, `actorId`, and `createdAt` are immutable after creation; `createdAt == request.time` on create and `updatedAt == request.time` on update.
5. **Relational Parent Verification**: Registrations, teams, projects, submissions, judge assignments, evaluations, and results verify parent document existence via `exists()` / `get()` on create.
6. **Terminal State Locking**: Completed hackathons (`status == 'completed'`) and submitted evaluations (`status == 'submitted'`) cannot be silently overwritten by non-admins.
7. **Evaluation Authority**: Only an assigned judge (who is NOT a member of the team and has declared no conflict) can create/update their own `/evaluations/{submissionId}_{judgeId}` document.
8. **Query-Enforced List Rules**: Every `allow list` rule evaluates `resource.data` directly (zero `get()` calls inside `list`) so unindexed/unauthorized scraping is rejected by Firestore.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Privilege Escalation (Ghost Admin Field)**: `POST /users/u1` with `{ accountRole: "admin" }` or `{ isAdmin: true }`. -> **DENIED** (enum + `keys().hasOnly()`).
2. **Admin Collection Poisoning**: `POST /admins/u1` by authenticated non-admin user. -> **DENIED** (`allow write: if false`).
3. **Unverified Email Spoofing**: `POST /hackathons/h1` with `email: "admin@example.test"` and `email_verified: false`. -> **DENIED** (`email_verified == true` required).
4. **PII Cross-User Read**: `GET /users/u2/private/info` by `u1`. -> **DENIED** (`isOwner(userId) || isAdmin()`).
5. **Owner Spoofing on Hackathon Create**: `POST /hackathons/h1` by `u1` with `organizerId: "u2"`. -> **DENIED** (`incoming().organizerId == request.auth.uid`).
6. **Timestamp Forgery**: `POST /hackathons/h1` with backdated `createdAt` != `request.time`. -> **DENIED**.
7. **Path ID Poisoning**: `POST /teams/bad$id!with*junk` (>128 chars or invalid regex). -> **DENIED** (`isValidId()`).
8. **Shadow Update Ghost Field**: `PATCH /users/u1` adding `verifiedBadge: true`. -> **DENIED** (`affectedKeys().hasOnly(...)` + `isValidUserProfile`).
9. **Orphaned Submission**: `POST /submissions/s1` referencing nonexistent `hackathonId: "missing"`. -> **DENIED** (`exists()` parent check).
10. **Self-Judging Conflict**: Judge attempts `POST /evaluations/s1_j1` on a submission where `j1` is in `submission.memberIds`. -> **DENIED**.
11. **Terminal State Mutation**: Participant updates `submissions/s1` after `status == 'evaluated'` or hackathon `status == 'completed'`. -> **DENIED**.
12. **Blanket List Scraping**: `LIST /registrations` or `LIST /notifications` without scoping to `userId` or `organizerId`. -> **DENIED** (`resource.data` enforcement).
