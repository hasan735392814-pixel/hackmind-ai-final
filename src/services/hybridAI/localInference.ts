import { getGenerativeModel, InferenceMode, type GenerateContentResult } from 'firebase/ai';
import { getFirebaseAIInstance } from './firebaseAI';

export async function runOnDeviceSingleTurn(params: {
  prompt: string;
  locale?: 'en' | 'ar';
  temperature?: number;
  topK?: number;
}): Promise<GenerateContentResult> {
  const ai = getFirebaseAIInstance();
  const lang = params.locale === 'ar' ? 'ar' : 'en';

  const model = getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: [lang] }],
        expectedOutputs: [{ type: 'text', languages: [lang] }],
        ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
        ...(typeof params.topK === 'number' ? { topK: params.topK } : {})
      }
    }
  });

  return model.generateContent(params.prompt);
}
