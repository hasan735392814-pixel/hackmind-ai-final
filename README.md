# HACKMIND AI

**From Hackathon Ideas to Winning Innovations.**

HACKMIND AI is a bilingual (English LTR / Arabic RTL) hackathon operations, team formation, AI mentoring, project submission, and transparent judging platform engineered for the **Firebase Spark (free) plan** (`hackmind-ai`) and **Firebase AI Logic Hybrid Inference**.

## Key Features
- **Hybrid AI Inference (`src/services/hybridAI/`)**: Uses `firebase/ai` (`getAI`, `GoogleAIBackend`, `getGenerativeModel`, `InferenceMode`) across `PREFER_ON_DEVICE`, `PREFER_IN_CLOUD`, `ONLY_ON_DEVICE`, and `ONLY_IN_CLOUD` with truthful `inferenceSource` reporting (`ON-DEVICE`, `CLOUD`, `FALLBACK TO CLOUD`, `LOCAL MODEL UNAVAILABLE`, `FAILED`), strict non-consent local confinement, granular hardware/model capability checks, and a live `HybridAIStatusPanel` (`DiagnosticsPage`) with manual single-request testing.
- **Evidence-Based Judging System V2 (`src/pages/EvidenceJudgingPage.tsx`)**: Independent 4-criteria rubric (`25% / 30% / 25% / 20%`), complete video exclusion, `QUOTA-SAFE MODE` (0 automatic Gemini calls), plus manual on-device-first quick evidence helpers (`evidence_excerpt_summary`, `evidence_criteria_classify`, `user_text_fact_extract`, `preliminary_summary`).
- **Role-Based Platform**: Landing showcase, Auth with email-verification gating, Organizer Studio (events, registrations, teams/submissions oversight, judge assignments, fair rankings engine, and admin oversight), Hackathon Discovery, Builder Workspace, Smart Team Matching, AI Mentor, Submissions, Legacy AI Judge Assistant, Sponsor Analytics, Notifications/Activity Feed, and Diagnostics.
- **Spark-Only Zero-Trust Security (`firestore.rules`)**:
  - Server/console-only `/admins/{uid}` authority (no hardcoded email privilege escalation).
  - Separated `requestedRole` vs admin-approved `approvedRole`.
  - Split public `/users/{uid}` profiles and owner-only `/users/{uid}/private/info` PII.
  - Double-hash (`SHA256(SHA256(token))`) team join-code verification with zero plaintext persistence and automatic post-commit purge of transient `joinClaims`.

## Main Technologies
- **Frontend**: React 19, TypeScript, Vite 8, Tailwind CSS v4, React Router v7, Lucide Icons, Motion
- **Backend / BaaS (Spark Plan — `hackmind-ai`)**: Firebase Authentication (Email/Password & Google), Cloud Firestore (`(default)` database), Firebase App Check (reCAPTCHA Enterprise), Firebase Remote Config, Firebase AI Logic (`GoogleAIBackend`)
- **Testing & Security Tooling**: Vitest, `@firebase/rules-unit-testing`, `@firebase/eslint-plugin-security-rules`, Firebase Local Emulator Suite

## Local Setup
1. **Install dependencies**:
   ```bash
   npm ci
   ```
2. **Configure Firebase environment variables**:
   Copy `.env.example` to `.env.local` and populate your Firebase Web App and reCAPTCHA Enterprise values from Firebase Console (`hackmind-ai` project):
   ```bash
   cp .env.example .env.local
   ```
   > Never commit `.env.local` or any file containing real debug tokens or secrets.
3. **Run the development server** (runs on port `3000`):
   ```bash
   npm run dev
   ```
4. **Build for production**:
   ```bash
   npm run build
   ```

## Environment Variables
`.env.example` provides the template for `hackmind-ai`:

| Variable | Purpose | Notes |
|---|---|---|
| `VITE_FIREBASE_API_KEY` | Public Firebase Web API key | From Firebase Console → Project Settings (`hackmind-ai`). |
| `VITE_FIREBASE_AUTH_DOMAIN` | Auth domain | Defaults to `hackmind-ai.firebaseapp.com`. |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID | Defaults to `hackmind-ai`. |
| `VITE_FIREBASE_STORAGE_BUCKET` | Storage bucket identifier | Defaults to `hackmind-ai.firebasestorage.app`. |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase messaging sender ID | From Firebase Console → Project Settings. |
| `VITE_FIREBASE_APP_ID` | Registered Firebase Web App ID | From Firebase Console → Project Settings. |
| `VITE_FIREBASE_MEASUREMENT_ID` | Optional Analytics measurement ID | Optional — omitted automatically when absent; Analytics initializes only when a valid `G-...` ID is configured. |
| `VITE_FIREBASE_FIRESTORE_DATABASE_ID` | Firestore database ID | Defaults to `(default)` on the Spark plan. |
| `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY` | Public reCAPTCHA Enterprise site key | Configured in Firebase Console → App Check. |
| `VITE_APPCHECK_DEBUG_TOKEN` | Optional local dev-only App Check debug token | Not required in Google AI Studio or normal operation; leave unset unless explicitly debugging App Check locally (`import.meta.env.DEV`). |
| `VITE_FIREBASE_AI_CLOUD_MODEL` | Primary cloud Gemini model override | Defaults to `gemini-3.5-flash-lite` (precedence: Env > Remote Config > Default). |
| `VITE_FIREBASE_AI_HEAVY_CLOUD_MODEL` | Heavy cloud Gemini model override | Defaults to `gemini-4-hydrogen` (used for judging/heavy analysis). |

> **Migration Note**: Legacy runtime initialization targeting `abstract-theater-f01dl` and named database `ai-studio-7c931fff-d8ab-4b91-838f-863f0a80ceb2` has been replaced in `src/services/firebase/config.ts`. The client reads `VITE_FIREBASE_*` env vars targeting `hackmind-ai` and connects to the `(default)` Firestore database (`firebase-applet-config.json` remains present solely for Google AI Studio workspace metadata and optional `appId`/diagnostic comparison).

## Automated Verification & Unit Tests
```bash
npx eslint firestore.rules   # Static security-rules lint (@firebase/eslint-plugin-security-rules)
npm run lint                 # TypeScript check across src/ and tests/
npm test                     # Vitest unit, integration & rules-spec suites
npm run build                # Production Vite bundle verification
```

## Firestore Emulator Security & Concurrency Tests
The full adversarial attack, lifecycle, and concurrency test suite lives in `tests/security/firestoreRules.emulator.test.ts`.

- **Prerequisite**: **Java 21+ (JDK)** is required locally to start the Firebase Firestore Emulator.
- **Run locally**:
  ```bash
  npm run test:rules
  ```
  Or with an explicit synthetic project ID (matching CI):
  ```bash
  npx firebase emulators:exec --project demo-hackmind-test --only firestore "npx vitest run tests/security/firestoreRules.emulator.test.ts"
  ```
- **CI Workflow**: `.github/workflows/firestore-rules-ci.yml` provisions Node.js 22 and Eclipse Temurin Java 21 to run rules ESLint, TypeScript checks, `npm test`, Emulator rules/concurrency tests, and `npm run build` completely offline with zero production credentials or deploy steps.

## Firebase Spark Compatibility & Current Prerequisites
- **100% Spark Compatible**: Designed without Cloud Functions, Blaze-only server triggers, or paid GCP services; notifications/activity feeds are derived from authoritative collections (`registrations`, `teamInvitations`, `judgeAssignments`, `hackathonResults`).
- **Console Prerequisites**: Before live browser testing against `hackmind-ai`, populate `.env.local` with the registered Web App credentials and ensure Authentication providers, `(default)` Firestore + rules/indexes deployment, and App Check domain allowlisting are completed in Firebase Console (see `FIREBASE_SETUP.md`).

## Additional Documentation
- `ARCHITECTURE.md`
- `FIREBASE_SETUP.md`
- `HYBRID_AI_SETUP.md`
- `SECURITY.md`
- `security_spec.md`
- `TESTING.md`
