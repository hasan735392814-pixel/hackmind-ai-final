# Firebase Setup Guide (`hackmind-ai` — Spark Plan)

This application targets Firebase project **`hackmind-ai`** and its **`(default)`** Cloud Firestore database on the **Spark (free)** plan. Client credentials are loaded from `VITE_FIREBASE_*` environment variables (never hardcoded into the repository).

## 1. Local Environment Variables (`.env.local`)
Copy `.env.example` to `.env.local` and paste the public Web App values from **Firebase Console → Project Settings → General → Your apps**:
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN=hackmind-ai.firebaseapp.com`
- `VITE_FIREBASE_PROJECT_ID=hackmind-ai`
- `VITE_FIREBASE_STORAGE_BUCKET=hackmind-ai.firebasestorage.app`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MEASUREMENT_ID` (optional — leave unset if Analytics is unused)
- `VITE_FIREBASE_FIRESTORE_DATABASE_ID=(default)`
- `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY` (from Firebase Console → App Check)

## 2. Cloud Firestore Database & Rules
1. Confirm the **`(default)`** Firestore database exists in Firebase Console (Spark plan allows a single `(default)` database).
2. Deploy security rules and composite indexes when ready:
   ```bash
   firebase use hackmind-ai
   firebase deploy --only firestore:rules,firestore:indexes
   ```
3. Before deploying, verify rules locally:
   ```bash
   npx eslint firestore.rules
   ```

## 3. Authentication Providers & Authorized Domains
1. In **Firebase Console → Authentication → Sign-in method**:
   - Enable **Email/Password**.
   - Enable **Google** sign-in.
2. In **Authentication → Settings → Authorized domains**, verify your active preview/production hostnames are listed alongside `localhost` and `hackmind-ai.firebaseapp.com`:
   - `ais-dev-z7epuy3wk5ayykjz2broun-291877706997.europe-west1.run.app`
   - `ais-pre-z7epuy3wk5ayykjz2broun-291877706997.europe-west1.run.app`
3. Note: Zero-trust Firestore rules require `request.auth.token.email_verified == true` for standard writes.

## 4. Firebase App Check (reCAPTCHA Enterprise)
1. Register the `hackmind-ai` Web App in **App Check** using **reCAPTCHA Enterprise**.
2. Add the preview/production hostnames to the reCAPTCHA Enterprise **Domain list** in Google Cloud / reCAPTCHA settings and set `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY` in `.env.local`.
3. Keep enforcement disabled until you confirm valid client App Check tokens in `/app/diagnostics`.

## 5. Firebase AI Logic & Remote Config
1. Enable **Firebase AI Logic (Gemini Developer API)** in Firebase Console for `hackmind-ai`.
2. Optional **Remote Config** parameters:
   - `ai_cloud_model` (default `gemini-3.5-flash-lite`)
   - `ai_heavy_cloud_model` (default `gemini-4-hydrogen`)
   - `ai_default_inference_mode` (`prefer_on_device`)
   - `ai_limited_use_appcheck` (`false`)

## 6. First Platform Admin Bootstrapping
Because `/admins/{uid}` blocks all client writes (`allow create, update, delete: if false;`), create your initial admin record once from **Firebase Console → Firestore → `(default)`**:
- Collection: `admins`
- Document ID: `<your-verified-firebase-uid>`
- Fields: `{ "uid": "<your-verified-firebase-uid>", "role": "admin" }`
