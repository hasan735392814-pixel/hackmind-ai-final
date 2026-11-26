# Testing & Quality Assurance

## Automated Test Suites (`vitest`)
- `tests/unit/firebaseConfigMigration.test.ts`: Environment-driven Firebase client configuration resolution targeting `hackmind-ai` and `(default)` Firestore (single-argument `getFirestore(firebaseApp)`), missing env key diagnostics without secret exposure, and bilingual Firebase Auth error formatting.
- `tests/unit/appCheckInit.test.ts`: App Check initialization order before Firestore/Auth/Firebase AI Logic, ReCaptchaEnterpriseProvider integration, missing site key non-blocking warning, HMR/reload idempotency guard, and debug token non-logging.
- `tests/unit/validationAndJudging.test.ts`: URL/GitHub repository validation, submission deadline checks, double-hash join code proof/verifier derivation, rubric weight validation, weighted score calculation, COI exclusion, disagreement anomaly detection, and fair teammate matching.
- `tests/integration/hybridAIManager.test.ts`: Device capability detection (including mobile unsupported reporting and unverified model labeling), verified `ON-DEVICE` vs `FALLBACK TO CLOUD`, `ONLY_ON_DEVICE` strict refusal when unavailable, strict explicit cloud consent gating (`false` and `undefined`), `gemini-3.5-flash-lite` vs `gemini-4-hydrogen` routing with deprecated `temperature` omitted, `ENV > Remote Config > Default` precedence + legacy 1.x/2.x override blocking, and EN/AR translation key parity.
- `tests/security/firestoreRulesSpec.test.ts`: Blueprint collection coverage, global default-deny check, email verification gates (`email_verified == true`), PII isolation (`/users/{userId}/private`), double-hash team join code rules, anti-self-judging invariants, server-side registration/submission deadline + published-status lock enforcement, and sponsor parent organizer validation.
- `tests/security/firestoreRules.emulator.test.ts`: Full Firestore Emulator adversarial security and concurrency suite (requires Java 21+ JDK; executed automatically in `.github/workflows/firestore-rules-ci.yml`).

## Automated Verification Commands
```bash
npx eslint firestore.rules   # Static security-rules lint (@firebase/eslint-plugin-security-rules)
npm run lint                 # TypeScript check across src/ and tests/
npm test                     # Vitest unit, integration & rules-spec suites
npm run build                # Production Vite bundle verification
npm run test:rules           # Full Firestore Emulator suite (requires Java 21+)
```

## Live Environment & Manual Verification Checklist
1. **Firebase Console & `.env.local` Prerequisites**: Populate `.env.local` from `.env.example` for project `hackmind-ai`, ensure Email/Password & Google Auth providers + Authorized Domains are configured, confirm `(default)` Firestore exists with `firestore.rules` & `firestore.indexes.json` deployed, and ensure Firebase AI Logic + App Check reCAPTCHA Enterprise are active.
2. **Auth & Email Verification Flow**: Register via Email/Password, verify email via link, reload verification status, and confirm Firestore `/users/{uid}` and `/users/{uid}/private/info` docs are created.
3. **Hybrid AI Verification**: Test `PREFER_ON_DEVICE`, `ONLY_ON_DEVICE`, `PREFER_IN_CLOUD`, and `ONLY_IN_CLOUD` in `/app/diagnostics` on desktop Chrome (Prompt API enabled) vs mobile/non-Prompt-API browsers to confirm truthful `ON-DEVICE`, `FALLBACK TO CLOUD`, `LOCAL MODEL UNAVAILABLE`, and `CLOUD` badges.
4. **Role Workflows**: Verify Organizer hackathon publish + judge assignment, Builder team creation/join-code/invite + submission, Judge repo inspection + COI + scoring, Fair Judging ranking publish, and Sponsor PII-free aggregate dashboard.
5. **Bilingual & Theme Parity**: Toggle EN (LTR) / AR (RTL) and Dark / Light modes across Landing and Workspace pages.
