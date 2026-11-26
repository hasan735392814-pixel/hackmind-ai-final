import { getAI, GoogleAIBackend, type AI } from 'firebase/ai';
import {
  firebaseApp,
  getCachedRemoteAIConfig,
  initAppCheckSafely
} from '../firebase/config';

let aiInstance: AI | null = null;

export function getFirebaseAIInstance(): AI {
  if (!aiInstance) {
    initAppCheckSafely();
    const remoteCfg = getCachedRemoteAIConfig();
    aiInstance = getAI(firebaseApp, {
      backend: new GoogleAIBackend(),
      useLimitedUseAppCheckTokens: remoteCfg.useLimitedUseAppCheckTokens
    });
  }
  return aiInstance;
}

export function getConfiguredCloudModels(): { standard: string; heavy: string } {
  const remoteCfg = getCachedRemoteAIConfig();
  return {
    standard: remoteCfg.cloudModelName,
    heavy: remoteCfg.heavyCloudModelName
  };
}
