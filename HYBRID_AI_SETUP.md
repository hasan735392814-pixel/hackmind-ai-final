# Hybrid AI Setup & Truthful Source Verification

## Firebase AI Logic Web Hybrid Integration
HACKMIND AI uses the official **Firebase AI Logic Web SDK** (`firebase@^13.3.0`, meeting the `>= 12.5.0` hybrid requirement) exclusively through the canonical layer in `src/services/hybridAI/`:
- `firebaseAI.ts`: Initializes `getAI(firebaseApp, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens })` after App Check (`initAppCheckSafely()`).
- `inferenceManager.ts`: Creates models with `getGenerativeModel(ai, { mode, onDeviceParams, inCloudParams })` across all four `InferenceMode` options:
  - `PREFER_ON_DEVICE` (`prefer_on_device`)
  - `PREFER_IN_CLOUD` (`prefer_in_cloud`)
  - `ONLY_ON_DEVICE` (`only_on_device`)
  - `ONLY_IN_CLOUD` (`only_in_cloud`)
- `deviceCapability.ts`: Inspects `window.LanguageModel.availability()` and distinguishes `available`, `downloadable`, `downloading`, `not_initialized`, `insufficient_resources`, `unavailable`, `unsupported_browser`, and `mobile_unsupported`.

## On-Device-First & Cloud Fallback Tasks
- **On-device-first tasks (`PREFER_ON_DEVICE`)**:
  - `evidence_excerpt_summary` — summarize short project evidence excerpts
  - `evidence_criteria_classify` — classify evidence into the four official criteria (`25% / 30% / 25% / 20%`)
  - `user_text_fact_extract` — extract verifiable facts from user-supplied text
  - `preliminary_summary` — short structured preliminary project overview
  - `team_matching`, `mentor_ideation`, `mentor_pitch`
- **Cloud-first / complex tasks**:
  - `judge_evidence` — deep multi-evidence audit (`ONLY_IN_CLOUD` / `gemini-4-hydrogen`, gated by `QUOTA-SAFE MODE` and explicit judge authorization)
  - `hackathon_builder`, `mentor_roadmap`, and oversized inputs exceeding `ON_DEVICE_SAFE_CHAR_LIMIT` (when Cloud AI consent is granted)

## Privacy, Cloud Consent & App Check
- When `PREFER_ON_DEVICE` is selected **without** `aiCloudConsent`, HACKMIND AI constrains execution to `ONLY_ON_DEVICE` so the SDK cannot silently fall back to Cloud Gemini without explicit user consent.
- App Check uses `ReCaptchaEnterpriseProvider` (`VITE_RECAPTCHA_ENTERPRISE_SITE_KEY`) with `isTokenAutoRefreshEnabled: true` and runs pre-flight token verification before cloud calls when initialized.

## On-Device Requirements & Honest Identity Reporting
- Web on-device inference via Firebase AI Logic relies on a compatible **desktop Chrome (139+)** environment exposing the `LanguageModel` Prompt API with a downloaded local model.
- Android Chrome and other mobile web browsers are truthfully reported as `mobile_unsupported` for web on-device execution and operate through Firebase AI Logic Cloud inference (when consented).
- Because the browser Prompt API does not cryptographically attest whether the underlying local model is Gemini Nano 4, the UI displays:
  `On-device AI — model identity not independently verified.`

## Status Indicators
Every AI response reads `result.response.inferenceSource` and surfaces one of:
- `ON-DEVICE`
- `CLOUD`
- `FALLBACK TO CLOUD` (with concrete fallback reason)
- `LOCAL MODEL UNAVAILABLE`
- `FAILED`
