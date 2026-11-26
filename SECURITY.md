# Security & Privacy Architecture

See `security_spec.md` and `firestore.rules` for the complete zero-trust specification.

## Key Controls
- **No Self-Assigned Admin Roles**: `users/{userId}` restricts `accountRole` to `participant | organizer | judge | sponsor`. Platform admins are verified strictly via server-managed `/admins/{uid}` documents or verified bootstrap email.
- **Split-Collection PII Isolation**: Email addresses and consent flags reside only in `/users/{userId}/private/info` (`isOwner(userId) || isAdmin()`).
- **Email Verification Gate**: All standard Firestore writes require `request.auth.token.email_verified == true`.
- **Cloud AI Privacy Consent**: Users must grant `aiCloudConsent` before project context is sent to cloud-hosted Gemini models.
- **Immutable Audit & AI Usage Logs**: `auditLogs` and `aiUsage` disallow client updates and deletes, and `aiUsage` never stores raw prompt text.
- **Rules Linting**: Validated with `@firebase/eslint-plugin-security-rules` (`npx eslint firestore.rules`).

## Evaluation Scoring Integrity & Known Limitations
- **Rules-Enforced Consistency Validation**: For `/evaluations/{evaluationId}`, `firestore.rules` enforces `criteriaScores` item structure, `0–10` score bounds, duplicate `criterionId` rejection, `totalWeight > 0`, conflict-of-interest invariants, non-empty non-COI final submissions, parent hackathon rubric matching (`criterionId` and `weight ±0.01`) on submission, and algebraic consistency of `weightedTotal` (`±0.02` on a `0–100` scale).
- **Client-Submitted `weightedTotal` Limitation**: Because HackMind AI runs as a client-only Firebase SPA without Cloud Functions or a trusted Admin SDK backend, `weightedTotal` (and organizer-published `rankings`) remains **client-submitted** rather than computed by a trusted server. Firestore Rules enforce mathematical consistency between the submitted `criteriaScores` and `weightedTotal`, not authoritative server-side calculation.
- **Firestore CEL 1,000-Expression Runtime Ceiling on Multi-Criterion Rubrics**: Under Firestore Security Rules v2, `let` bindings and function parameters do not memoize at runtime (every reference re-evaluates the AST path), and the language provides no iteration/map/reduce primitives. With strict per-criterion schema, bounds (`0–10` / `0–100`), duplicate-ID, weighted-total consistency, and parent rubric checks active, the Firestore Emulator verifies that execution succeeds up to **2 criteria** for final submissions (`3` criteria for drafts) before hitting Firestore's hard **1,000-expression evaluation limit** (including the 4-criterion `DEFAULT_RUBRIC` and 10-criterion rubrics). Supporting full validation on 3–10 criteria requires moving scoring validation/computation to a trusted server endpoint (Cloud Functions / Admin SDK) or redesigning `evaluations` away from single-document `criteriaScores` lists.

*Note: Always review and test `firestore.rules` with the Firebase Emulator Suite against your specific production workflows before broad public release.*
