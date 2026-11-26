import {
  getGenerativeModel,
  InferenceMode,
  type GenerateContentResult,
  type GenerationConfig,
  type SchemaRequest
} from 'firebase/ai';
import { getConfiguredCloudModels, getFirebaseAIInstance } from './firebaseAI';

export async function runCloudInference(params: {
  prompt: string;
  systemInstruction?: string;
  useHeavyModel?: boolean;
  expectJson?: boolean;
  responseSchema?: SchemaRequest;
  temperature?: number;
}): Promise<{ result: GenerateContentResult; modelName: string }> {
  const ai = getFirebaseAIInstance();
  const models = getConfiguredCloudModels();
  const modelName = params.useHeavyModel ? models.heavy : models.standard;
  const isLegacyPre3Model = /^gemini-[12]\./i.test(modelName);

  const generationConfig: GenerationConfig = {
    ...(isLegacyPre3Model && typeof params.temperature === 'number'
      ? { temperature: params.temperature }
      : {}),
    ...(params.expectJson ? { responseMimeType: 'application/json' } : {}),
    ...(params.responseSchema ? { responseSchema: params.responseSchema } : {})
  };

  const model = getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model: modelName,
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      ...(params.systemInstruction ? { systemInstruction: params.systemInstruction } : {})
    }
  });

  const result = await model.generateContent(params.prompt);
  return { result, modelName };
}
