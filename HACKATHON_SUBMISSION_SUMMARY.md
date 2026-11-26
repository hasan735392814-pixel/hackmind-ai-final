# HackMind AI — #BuildHybridAI 2026 Technical Summary

## Hackathon Period Upgrades (Since November 11, 2026)
All upgrades extend the existing HackMind AI architecture (`hackmind-ai` Firebase project, `(default)` Firestore database, MIT License) without rebuilding or breaking existing workflows.

### 1. Official Firebase AI Logic Web Hybrid Architecture (`src/services/hybridAI/`)
- **SDK Version**: `firebase@^13.3.0` (`>= 12.5.0` required for Web Hybrid Inference).
- **Initialization (`firebaseAI.ts`)**: `getAI(firebaseApp, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens })` paired with `initAppCheckSafely()` (`ReCaptchaEnterpriseProvider` with auto-refresh enabled).
- **Hybrid Model Configuration (`inferenceManager.ts`)**: `getGenerativeModel(ai, { mode, onDeviceParams, inCloudParams })` using `InferenceMode.{PREFER_ON_DEVICE, PREFER_IN_CLOUD, ONLY_ON_DEVICE, ONLY_IN_CLOUD}`.
- **Truthful Runtime Verification**: Reads `result.response.inferenceSource` (`ON_DEVICE` / `IN_CLOUD`) and surfaces exact status (`ON-DEVICE`, `CLOUD`, `FALLBACK TO CLOUD`, `LOCAL MODEL UNAVAILABLE`, `FAILED`). Never fabricates local execution or claims unverified Gemini Nano 4 hardware identity.

### 2. Meaningful On-Device & Cloud Fallback Use Cases
- **On-Device-First Tasks (`PREFER_ON_DEVICE`, `OnDeviceQuickHelpersPanel.tsx`)**:
  1. `evidence_excerpt_summary` — summarize short project evidence excerpts.
  2. `evidence_criteria_classify` — classify evidence strictly into the 4 official judging criteria (`25% / 30% / 25% / 20%`).
  3. `user_text_fact_extract` — extract concrete facts and open verification questions from user-supplied text.
  4. `preliminary_summary` — generate short structured preliminary summaries.
- **Cloud Fallback & Complex Tasks (`quotaProtectedAnalyzer.ts`)**:
  - Deep multi-file evidence auditing (`judge_evidence` -> `gemini-4-hydrogen`), builder/roadmap generation, and inputs exceeding `ON_DEVICE_SAFE_CHAR_LIMIT` (4,500 chars) route cleanly to Cloud Gemini when user consent is granted.
  - When `PREFER_ON_DEVICE` is selected without `aiCloudConsent`, `inferenceManager.ts` confines SDK execution to `ONLY_ON_DEVICE` so no silent cloud fallback occurs without explicit consent.

### 3. Hybrid AI Status Panel & Quota-Safe Guarantees
- **`HybridAIStatusPanel` (`src/components/common/HybridAIStatusPanel.tsx`, rendered in `DiagnosticsPage.tsx`)**:
  - Surfaces Hybrid AI engine state, local model availability (`available`, `downloadable`, `downloading`, `not_initialized`, `insufficient_resources`, `unavailable`, `unsupported_browser`, `mobile_unsupported`), active inference mode, last `sdkInferenceSource` & truthful badge, cloud fallback readiness, App Check state, consent toggle, last result/error, and a **manual 1-request Hybrid Inference Test** (0 automatic calls on load).
- **QUOTA-SAFE MODE Preserved**: Zero automatic Gemini requests on mount, navigation, repository inspection, or refresh; human judges retain 100% authority over the 4 fixed criteria and official scores.

### 4. Submission Checklist Notes
- **License**: `LICENSE` (MIT) present at repository root.
- **Live Verification Note**: Automated tests run against mocked Firebase AI Logic SDKs (`0` Gemini quota consumed). Real on-device Chrome Prompt API inference must be verified manually in a compatible desktop Chrome 139+ browser with built-in AI enabled and `.env.local` populated (`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY`).
- **Pending Manual Hackathon Deliverables**: Record & upload the `<= 3 minute` English demo video showing real Hybrid AI execution, verify public GitHub repository visibility/remote history, and submit on Devpost before the deadline.
