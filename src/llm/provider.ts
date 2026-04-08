import { config } from '../config.js';
import { AppError } from '../utils.js';

export interface VisionRequest {
  prompt: string;
  fileName: string;
  mimeType: string;
  base64Data: string;
}

export interface VisionResponse {
  rawText: string;
}

export interface LlmProvider {
  readonly providerName: string;
  healthCheck(): Promise<void>;
  analyzeDocument(request: VisionRequest): Promise<VisionResponse>;
  repairJson(rawResponse: string, originalPrompt: string): Promise<VisionResponse>;
  validateSession(prompt: string): Promise<VisionResponse>;
}

function contentTypeFromMime(mimeType: string): 'image_url' | 'file' {
  return mimeType === 'application/pdf' ? 'file' : 'image_url';
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new AppError(500, 'INTERNAL_ERROR', `LLM provider request failed with ${response.status}`);
  }

  return response.json();
}

class MockProvider implements LlmProvider {
  readonly providerName = 'mock';

  async healthCheck(): Promise<void> {
    return;
  }

  async analyzeDocument(request: VisionRequest): Promise<VisionResponse> {
    if (request.fileName.includes('broken')) {
      return {
        rawText: '```json\n{"detection":{"documentType":"OTHER","documentName":"Unknown Document","category":"OTHER","applicableRole":"N/A","isRequired":false,"confidence":"LOW","detectionReason":"The mock provider could not identify the document."},"holder":{"fullName":null,"dateOfBirth":null,"nationality":null,"passportNumber":null,"sirbNumber":null,"rank":null,"photo":"ABSENT"},"fields":[],"validity":{"dateOfIssue":null,"dateOfExpiry":null,"isExpired":false,"daysUntilExpiry":null,"revalidationRequired":null},"compliance":{"issuingAuthority":null,"regulationReference":null,"imoModelCourse":null,"recognizedAuthority":null,"limitations":null},"medicalData":{"fitnessResult":"N/A","drugTestResult":"N/A","restrictions":null,"specialNotes":null,"expiryDate":null},"flags":[{"severity":"MEDIUM","message":"Mock low-confidence result"}],"summary":"Mock fallback."}\n```'
      };
    }

    return {
      rawText: JSON.stringify({
        detection: {
          documentType: request.fileName.toUpperCase().includes('PEME') ? 'PEME' : 'OTHER',
          documentName: request.fileName.toUpperCase().includes('PEME') ? 'Pre-Employment Medical Examination' : 'Unknown Document',
          category: request.fileName.toUpperCase().includes('PEME') ? 'MEDICAL' : 'OTHER',
          applicableRole: 'ENGINE',
          isRequired: true,
          confidence: 'HIGH',
          detectionReason: `Mock detection based on file name ${request.fileName}`
        },
        holder: {
          fullName: 'Samuel P. Samoya',
          dateOfBirth: '12/03/1988',
          nationality: 'Filipino',
          passportNumber: 'P1234567',
          sirbNumber: 'C0869326',
          rank: 'Third Engineer',
          photo: 'PRESENT'
        },
        fields: [
          {
            key: 'certificate_number',
            label: 'Certificate Number',
            value: 'MOCK-123',
            importance: 'HIGH',
            status: 'OK'
          }
        ],
        validity: {
          dateOfIssue: '06/01/2025',
          dateOfExpiry: '06/01/2027',
          isExpired: false,
          daysUntilExpiry: 660,
          revalidationRequired: false
        },
        compliance: {
          issuingAuthority: 'Mock Authority',
          regulationReference: null,
          imoModelCourse: null,
          recognizedAuthority: true,
          limitations: null
        },
        medicalData: {
          fitnessResult: 'FIT',
          drugTestResult: 'NEGATIVE',
          restrictions: null,
          specialNotes: null,
          expiryDate: '06/01/2027'
        },
        flags: [],
        summary: 'Mock extraction for testing.'
      })
    };
  }

  async repairJson(rawResponse: string): Promise<VisionResponse> {
    return { rawText: rawResponse.replace('```json', '').replace('```', '').trim() };
  }

  async validateSession(prompt: string): Promise<VisionResponse> {
    return {
      rawText: JSON.stringify({
        holderProfile: {
          fullName: 'Samuel P. Samoya',
          role: 'ENGINE'
        },
        consistencyChecks: [
          {
            check: 'Identity alignment',
            status: 'PASS',
            details: 'Mock validation found consistent identity fields.',
            documentsUsed: ['mock.pdf']
          }
        ],
        missingDocuments: [],
        expiringDocuments: [],
        medicalFlags: [],
        overallStatus: 'APPROVED',
        overallScore: prompt.length > 0 ? 92 : 0,
        summary: 'Mock validation indicates the session is ready for review.',
        recommendations: ['Proceed to human review for final approval.']
      })
    };
  }
}

class OpenAiCompatibleProvider implements LlmProvider {
  readonly providerName: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(providerName: string, url: string, headers: Record<string, string>) {
    this.providerName = providerName;
    this.url = url;
    this.headers = headers;
  }

  async healthCheck(): Promise<void> {
    if (!config.llmApiKey) {
      throw new AppError(500, 'INTERNAL_ERROR', 'Missing LLM API key');
    }
  }

  async analyzeDocument(request: VisionRequest): Promise<VisionResponse> {
    const content = contentTypeFromMime(request.mimeType) === 'file'
      ? [{ type: 'text', text: request.prompt }, { type: 'file', file: { filename: request.fileName, file_data: `data:${request.mimeType};base64,${request.base64Data}` } }]
      : [{ type: 'text', text: request.prompt }, { type: 'image_url', image_url: { url: `data:${request.mimeType};base64,${request.base64Data}` } }];

    const response = await postJson(this.url, this.headers, {
      model: config.llmModel,
      messages: [{ role: 'user', content }],
      temperature: 0
    }) as { choices?: Array<{ message?: { content?: string | Array<{ text?: string; type?: string }> } }> };

    const message = response.choices?.[0]?.message?.content;
    if (typeof message === 'string') {
      return { rawText: message };
    }

    if (Array.isArray(message)) {
      const text = message.map((item) => item.text ?? '').join('');
      return { rawText: text };
    }

    throw new AppError(500, 'INTERNAL_ERROR', 'LLM provider returned no text');
  }

  async repairJson(rawResponse: string, originalPrompt: string): Promise<VisionResponse> {
    const response = await postJson(this.url, this.headers, {
      model: config.llmModel,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Return only clean JSON. Original task:\n${originalPrompt}\n\nRaw model output:\n${rawResponse}`
            }
          ]
        }
      ],
      temperature: 0
    }) as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };

    const message = response.choices?.[0]?.message?.content;
    if (typeof message === 'string') {
      return { rawText: message };
    }

    if (Array.isArray(message)) {
      return { rawText: message.map((item) => item.text ?? '').join('') };
    }

    throw new AppError(500, 'INTERNAL_ERROR', 'LLM provider returned no repair text');
  }

  async validateSession(prompt: string): Promise<VisionResponse> {
    const response = await postJson(this.url, this.headers, {
      model: config.llmModel,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature: 0
    }) as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };

    const message = response.choices?.[0]?.message?.content;
    if (typeof message === 'string') {
      return { rawText: message };
    }

    if (Array.isArray(message)) {
      return { rawText: message.map((item) => item.text ?? '').join('') };
    }

    throw new AppError(500, 'INTERNAL_ERROR', 'LLM provider returned no validation text');
  }
}

class AnthropicProvider implements LlmProvider {
  readonly providerName = 'anthropic';

  async healthCheck(): Promise<void> {
    if (!config.llmApiKey) {
      throw new AppError(500, 'INTERNAL_ERROR', 'Missing LLM API key');
    }
  }

  async analyzeDocument(request: VisionRequest): Promise<VisionResponse> {
    const documentContent = request.mimeType === 'application/pdf'
      ? [{ type: 'document', source: { type: 'base64', media_type: request.mimeType, data: request.base64Data } }, { type: 'text', text: request.prompt }]
      : [{ type: 'image', source: { type: 'base64', media_type: request.mimeType, data: request.base64Data } }, { type: 'text', text: request.prompt }];

    const response = await postJson(config.llmBaseUrl ?? 'https://api.anthropic.com/v1/messages', {
      'x-api-key': config.llmApiKey,
      'anthropic-version': '2023-06-01'
    }, {
      model: config.llmModel,
      max_tokens: 4096,
      messages: [{ role: 'user', content: documentContent }]
    }) as { content?: Array<{ type?: string; text?: string }> };

    const text = response.content?.map((item) => item.text ?? '').join('') ?? '';
    if (!text) {
      throw new AppError(500, 'INTERNAL_ERROR', 'Anthropic returned no text');
    }

    return { rawText: text };
  }

  async repairJson(rawResponse: string, originalPrompt: string): Promise<VisionResponse> {
    const response = await postJson(config.llmBaseUrl ?? 'https://api.anthropic.com/v1/messages', {
      'x-api-key': config.llmApiKey,
      'anthropic-version': '2023-06-01'
    }, {
      model: config.llmModel,
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Return only valid JSON. Original task:\n${originalPrompt}\n\nRaw output:\n${rawResponse}` }] }]
    }) as { content?: Array<{ text?: string }> };

    return { rawText: response.content?.map((item) => item.text ?? '').join('') ?? '' };
  }

  async validateSession(prompt: string): Promise<VisionResponse> {
    const response = await postJson(config.llmBaseUrl ?? 'https://api.anthropic.com/v1/messages', {
      'x-api-key': config.llmApiKey,
      'anthropic-version': '2023-06-01'
    }, {
      model: config.llmModel,
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    }) as { content?: Array<{ text?: string }> };

    return { rawText: response.content?.map((item) => item.text ?? '').join('') ?? '' };
  }
}

class GeminiProvider implements LlmProvider {
  readonly providerName = 'gemini';

  async healthCheck(): Promise<void> {
    if (!config.llmApiKey) {
      throw new AppError(500, 'INTERNAL_ERROR', 'Missing LLM API key');
    }
  }

  async analyzeDocument(request: VisionRequest): Promise<VisionResponse> {
    const response = await postJson(
      `${config.llmBaseUrl ?? 'https://generativelanguage.googleapis.com'}/v1beta/models/${config.llmModel}:generateContent?key=${config.llmApiKey}`,
      {},
      {
        contents: [
          {
            role: 'user',
            parts: [
              { text: request.prompt },
              { inlineData: { mimeType: request.mimeType, data: request.base64Data } }
            ]
          }
        ],
        generationConfig: { temperature: 0 }
      }
    ) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };

    const text = response.candidates?.[0]?.content?.parts?.map((item) => item.text ?? '').join('') ?? '';
    if (!text) {
      throw new AppError(500, 'INTERNAL_ERROR', 'Gemini returned no text');
    }

    return { rawText: text };
  }

  async repairJson(rawResponse: string, originalPrompt: string): Promise<VisionResponse> {
    return this.validateSession(`Return only valid JSON. Original task:\n${originalPrompt}\n\nRaw output:\n${rawResponse}`);
  }

  async validateSession(prompt: string): Promise<VisionResponse> {
    const response = await postJson(
      `${config.llmBaseUrl ?? 'https://generativelanguage.googleapis.com'}/v1beta/models/${config.llmModel}:generateContent?key=${config.llmApiKey}`,
      {},
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 }
      }
    ) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };

    return { rawText: response.candidates?.[0]?.content?.parts?.map((item) => item.text ?? '').join('') ?? '' };
  }
}

export function createLlmProvider(): LlmProvider {
  switch (config.llmProvider.toLowerCase()) {
    case 'anthropic':
      return new AnthropicProvider();
    case 'openai':
      return new OpenAiCompatibleProvider('openai', config.llmBaseUrl ?? 'https://api.openai.com/v1/chat/completions', {
        authorization: `Bearer ${config.llmApiKey}`
      });
    case 'groq':
      return new OpenAiCompatibleProvider('groq', config.llmBaseUrl ?? 'https://api.groq.com/openai/v1/chat/completions', {
        authorization: `Bearer ${config.llmApiKey}`
      });
    case 'mistral':
      return new OpenAiCompatibleProvider('mistral', config.llmBaseUrl ?? 'https://api.mistral.ai/v1/chat/completions', {
        authorization: `Bearer ${config.llmApiKey}`
      });
    case 'ollama':
      return new OpenAiCompatibleProvider('ollama', config.llmBaseUrl ?? 'http://localhost:11434/v1/chat/completions', {});
    case 'gemini':
      return new GeminiProvider();
    case 'mock':
      return new MockProvider();
    default:
      throw new AppError(500, 'INTERNAL_ERROR', `Unsupported provider ${config.llmProvider}`);
  }
}
