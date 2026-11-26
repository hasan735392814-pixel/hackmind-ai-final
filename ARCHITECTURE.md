# HACKMIND AI — Architecture

## Frontend Architecture
- **Framework**: React 19, TypeScript, Vite 8, Tailwind CSS v4, React Router v7 (`BrowserRouter`).
- **Internationalization**: `src/i18n/translations.ts` + `LanguageContext` supporting English (`ltr`) and Arabic (`rtl`) with persistent preference.
- **Theming**: `ThemeContext` synchronized with Tailwind v4 `@custom-variant dark`.

## Service Layers
- `src/services/firebase/config.ts`: Initializes Firebase App, Firestore (`ai-studio-...` named database), Auth, App Check (`ReCaptchaEnterpriseProvider`), and Remote Config.
- `src/services/firebase/firestoreService.ts`: Typed Firestore CRUD and real-time subscriptions with structured `handleFirestoreError` logging.
- `src/services/hybridAI/`:
  - `firebaseAI.ts`: `getAI(firebaseApp, { backend: new GoogleAIBackend() })`
  - `deviceCapability.ts`: Desktop vs. mobile environment check & `window.LanguageModel.availability()` probe
  - `localInference.ts`: `InferenceMode.ONLY_ON_DEVICE`
  - `cloudInference.ts`: `InferenceMode.ONLY_IN_CLOUD` with configurable Remote Config model names
  - `inferenceManager.ts`: Mode routing (`PREFER_ON_DEVICE`, `PREFER_IN_CLOUD`, `ONLY_ON_DEVICE`, `ONLY_IN_CLOUD`), cloud consent gate, timeout handling, offline draft persistence, and truthful `inferenceSource` reporting
  - `inferenceLogger.ts`: Diagnostics telemetry counters and non-sensitive `aiUsage` persistence
  - `promptRegistry.ts`: Task-specific system instructions and structured JSON contracts
- `src/services/judging/fairJudgingEngine.ts`: Weighted rubric validation, multi-judge calibration, disagreement spread, COI exclusion, and deterministic rankings.
- `src/services/github/repoInspector.ts`: Non-fabricating public GitHub repository metadata & README fetcher.
- `src/services/matching/teamMatching.ts`: Fair skill/role/availability compatibility engine.
