export type DetectionConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type ApplicableRole = 'DECK' | 'ENGINE' | 'BOTH' | 'N/A';
export type ExtractionStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETE' | 'FAILED';
export type ValidationStatus = 'APPROVED' | 'CONDITIONAL' | 'REJECTED';

export interface ExtractedField {
  key: string;
  label: string;
  value: string;
  importance: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  status: 'OK' | 'EXPIRED' | 'WARNING' | 'MISSING' | 'N/A';
}

export interface ExtractionFlag {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
}

export interface ExtractionValidity {
  dateOfIssue: string | null;
  dateOfExpiry: string | 'No Expiry' | 'Lifetime' | null;
  isExpired: boolean;
  daysUntilExpiry: number | null;
  revalidationRequired: boolean | null;
}

export interface ExtractionCompliance {
  issuingAuthority: string | null;
  regulationReference: string | null;
  imoModelCourse: string | null;
  recognizedAuthority: boolean | null;
  limitations: string | null;
}

export interface ExtractionMedicalData {
  fitnessResult: 'FIT' | 'UNFIT' | 'N/A';
  drugTestResult: 'NEGATIVE' | 'POSITIVE' | 'N/A';
  restrictions: string | null;
  specialNotes: string | null;
  expiryDate: string | null;
}

export interface ExtractionPayload {
  detection: {
    documentType: string;
    documentName: string;
    category: 'IDENTITY' | 'CERTIFICATION' | 'STCW_ENDORSEMENT' | 'MEDICAL' | 'TRAINING' | 'FLAG_STATE' | 'OTHER';
    applicableRole: ApplicableRole;
    isRequired: boolean;
    confidence: DetectionConfidence;
    detectionReason: string;
  };
  holder: {
    fullName: string | null;
    dateOfBirth: string | null;
    nationality: string | null;
    passportNumber: string | null;
    sirbNumber: string | null;
    rank: string | null;
    photo: 'PRESENT' | 'ABSENT';
  };
  fields: ExtractedField[];
  validity: ExtractionValidity;
  compliance: ExtractionCompliance;
  medicalData: ExtractionMedicalData;
  flags: ExtractionFlag[];
  summary: string;
}

export interface ExtractionRecord {
  id: string;
  sessionId: string;
  fileName: string;
  mimeType: string;
  fileHash: string;
  storedFilePath: string | null;
  documentType: string | null;
  documentName: string | null;
  applicableRole: ApplicableRole | null;
  category: string | null;
  confidence: DetectionConfidence | null;
  holderName: string | null;
  dateOfBirth: string | null;
  sirbNumber: string | null;
  passportNumber: string | null;
  fields: ExtractedField[];
  validity: ExtractionValidity | null;
  compliance: ExtractionCompliance | null;
  medicalData: ExtractionMedicalData | null;
  flags: ExtractionFlag[];
  isExpired: boolean;
  summary: string | null;
  rawLlmResponse: string | null;
  promptVersion: string;
  processingTimeMs: number | null;
  status: 'COMPLETE' | 'FAILED';
  createdAt: string;
}

export interface ValidationResult {
  sessionId: string;
  holderProfile: Record<string, unknown>;
  consistencyChecks: Array<Record<string, unknown>>;
  missingDocuments: Array<Record<string, unknown>>;
  expiringDocuments: Array<Record<string, unknown>>;
  medicalFlags: Array<Record<string, unknown>>;
  overallStatus: ValidationStatus;
  overallScore: number;
  summary: string;
  recommendations: string[];
  validatedAt: string;
}

export interface HealthResponse {
  status: 'OK' | 'WARN';
  version: string;
  uptime: number;
  dependencies: {
    database: 'OK' | 'ERROR';
    llmProvider: 'OK' | 'ERROR';
    queue: 'OK' | 'ERROR';
  };
  timestamp: string;
}
