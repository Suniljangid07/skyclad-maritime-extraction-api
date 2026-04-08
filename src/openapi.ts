export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'SkyClad Maritime Extraction API',
    version: '1.0.0',
    description: 'Interactive API documentation for maritime document extraction, async jobs, validation, reporting, and expiry review.'
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Local development server'
    }
  ],
  tags: [
    { name: 'Extraction' },
    { name: 'Jobs' },
    { name: 'Sessions' },
    { name: 'Health' }
  ],
  components: {
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'LLM_JSON_PARSE_FAIL' },
          message: { type: 'string' },
          extractionId: { type: 'string', nullable: true },
          retryAfterMs: { type: 'number', nullable: true }
        },
        required: ['error', 'message', 'extractionId', 'retryAfterMs']
      },
      ExtractionField: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          value: { type: 'string' },
          importance: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          status: { type: 'string', enum: ['OK', 'EXPIRED', 'WARNING', 'MISSING', 'N/A'] }
        },
        required: ['key', 'label', 'value', 'importance', 'status']
      },
      ExtractionFlag: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          message: { type: 'string' }
        },
        required: ['severity', 'message']
      },
      ExtractionValidity: {
        type: 'object',
        properties: {
          dateOfIssue: { type: 'string', nullable: true },
          dateOfExpiry: { type: 'string', nullable: true },
          isExpired: { type: 'boolean' },
          daysUntilExpiry: { type: 'number', nullable: true },
          revalidationRequired: { type: 'boolean', nullable: true }
        },
        required: ['dateOfIssue', 'dateOfExpiry', 'isExpired', 'daysUntilExpiry', 'revalidationRequired']
      },
      ExtractionCompliance: {
        type: 'object',
        properties: {
          issuingAuthority: { type: 'string', nullable: true },
          regulationReference: { type: 'string', nullable: true },
          imoModelCourse: { type: 'string', nullable: true },
          recognizedAuthority: { type: 'boolean', nullable: true },
          limitations: { type: 'string', nullable: true }
        },
        required: ['issuingAuthority', 'regulationReference', 'imoModelCourse', 'recognizedAuthority', 'limitations']
      },
      ExtractionMedicalData: {
        type: 'object',
        properties: {
          fitnessResult: { type: 'string', enum: ['FIT', 'UNFIT', 'N/A'] },
          drugTestResult: { type: 'string', enum: ['NEGATIVE', 'POSITIVE', 'N/A'] },
          restrictions: { type: 'string', nullable: true },
          specialNotes: { type: 'string', nullable: true },
          expiryDate: { type: 'string', nullable: true }
        },
        required: ['fitnessResult', 'drugTestResult', 'restrictions', 'specialNotes', 'expiryDate']
      },
      ExtractionResponse: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          sessionId: { type: 'string' },
          fileName: { type: 'string' },
          documentType: { type: 'string', nullable: true },
          documentName: { type: 'string', nullable: true },
          applicableRole: { type: 'string', nullable: true },
          category: { type: 'string', nullable: true },
          confidence: { type: 'string', nullable: true },
          holderName: { type: 'string', nullable: true },
          dateOfBirth: { type: 'string', nullable: true },
          sirbNumber: { type: 'string', nullable: true },
          passportNumber: { type: 'string', nullable: true },
          fields: { type: 'array', items: { $ref: '#/components/schemas/ExtractionField' } },
          validity: { $ref: '#/components/schemas/ExtractionValidity' },
          compliance: { $ref: '#/components/schemas/ExtractionCompliance' },
          medicalData: { $ref: '#/components/schemas/ExtractionMedicalData' },
          flags: { type: 'array', items: { $ref: '#/components/schemas/ExtractionFlag' } },
          isExpired: { type: 'boolean' },
          processingTimeMs: { type: 'number', nullable: true },
          summary: { type: 'string', nullable: true },
          createdAt: { type: 'string' }
        },
        required: ['id', 'sessionId', 'fileName', 'fields', 'validity', 'compliance', 'medicalData', 'flags', 'isExpired', 'createdAt']
      },
      AsyncAcceptedResponse: {
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          sessionId: { type: 'string' },
          status: { type: 'string', example: 'QUEUED' },
          pollUrl: { type: 'string' },
          estimatedWaitMs: { type: 'number' }
        },
        required: ['jobId', 'sessionId', 'status', 'pollUrl', 'estimatedWaitMs']
      },
      JobProcessingResponse: {
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          status: { type: 'string' },
          queuePosition: { type: 'number' },
          startedAt: { type: 'string', nullable: true },
          estimatedCompleteMs: { type: 'number' }
        },
        required: ['jobId', 'status', 'queuePosition', 'startedAt', 'estimatedCompleteMs']
      },
      JobCompleteResponse: {
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          status: { type: 'string', example: 'COMPLETE' },
          extractionId: { type: 'string' },
          result: { $ref: '#/components/schemas/ExtractionResponse' },
          completedAt: { type: 'string' }
        },
        required: ['jobId', 'status', 'extractionId', 'result', 'completedAt']
      },
      JobFailedResponse: {
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          status: { type: 'string', example: 'FAILED' },
          error: { type: 'string' },
          message: { type: 'string' },
          failedAt: { type: 'string', nullable: true },
          retryable: { type: 'boolean' }
        },
        required: ['jobId', 'status', 'error', 'message', 'failedAt', 'retryable']
      },
      SessionSummaryResponse: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          documentCount: { type: 'number' },
          detectedRole: { type: 'string' },
          overallHealth: { type: 'string' },
          documents: { type: 'array', items: { type: 'object' } },
          pendingJobs: { type: 'array', items: { type: 'object' } }
        },
        required: ['sessionId', 'documentCount', 'detectedRole', 'overallHealth', 'documents', 'pendingJobs']
      },
      ValidationResponse: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          holderProfile: { type: 'object', additionalProperties: true },
          consistencyChecks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          missingDocuments: { type: 'array', items: { type: 'object', additionalProperties: true } },
          expiringDocuments: { type: 'array', items: { type: 'object', additionalProperties: true } },
          medicalFlags: { type: 'array', items: { type: 'object', additionalProperties: true } },
          overallStatus: { type: 'string', enum: ['APPROVED', 'CONDITIONAL', 'REJECTED'] },
          overallScore: { type: 'number' },
          summary: { type: 'string' },
          recommendations: { type: 'array', items: { type: 'string' } },
          validatedAt: { type: 'string' }
        },
        required: ['sessionId', 'holderProfile', 'consistencyChecks', 'missingDocuments', 'expiringDocuments', 'medicalFlags', 'overallStatus', 'overallScore', 'summary', 'recommendations', 'validatedAt']
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          version: { type: 'string' },
          uptime: { type: 'number' },
          dependencies: { type: 'object', additionalProperties: { type: 'string' } },
          timestamp: { type: 'string' }
        },
        required: ['status', 'version', 'uptime', 'dependencies', 'timestamp']
      }
    }
  },
  paths: {
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check endpoint with dependency status',
        responses: {
          '200': {
            description: 'Health status',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' }
              }
            }
          }
        }
      }
    },
    '/api/extract': {
      post: {
        tags: ['Extraction'],
        summary: 'Upload a maritime document and extract structured data',
        parameters: [
          {
            name: 'mode',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['sync', 'async'],
              default: 'sync'
            },
            required: false,
            description: 'Use sync for inline extraction or async to enqueue the job.'
          }
        ],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  document: {
                    type: 'string',
                    format: 'binary'
                  },
                  sessionId: {
                    type: 'string',
                    nullable: true
                  },
                  webhookUrl: {
                    type: 'string',
                    nullable: true,
                    description: 'Optional for async mode. Receives job completion callbacks.'
                  }
                },
                required: ['document']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Extraction result or deduplicated existing result',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ExtractionResponse' }
              }
            }
          },
          '202': {
            description: 'Async job accepted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AsyncAcceptedResponse' }
              }
            }
          },
          '400': {
            description: 'Bad request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' }
              }
            }
          },
          '413': {
            description: 'File too large',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' }
              }
            }
          },
          '429': {
            description: 'Rate limited',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' }
              }
            }
          }
        }
      }
    },
    '/api/jobs/{jobId}': {
      get: {
        tags: ['Jobs'],
        summary: 'Poll async job status',
        parameters: [
          {
            name: 'jobId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        responses: {
          '200': {
            description: 'Current job state',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/JobProcessingResponse' },
                    { $ref: '#/components/schemas/JobCompleteResponse' },
                    { $ref: '#/components/schemas/JobFailedResponse' }
                  ]
                }
              }
            }
          },
          '404': {
            description: 'Job not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' }
              }
            }
          }
        }
      }
    },
    '/api/jobs/{jobId}/retry': {
      post: {
        tags: ['Jobs'],
        summary: 'Retry a failed extraction job',
        parameters: [
          {
            name: 'jobId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        responses: {
          '202': {
            description: 'Retry accepted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AsyncAcceptedResponse' }
              }
            }
          },
          '409': {
            description: 'Job cannot be retried',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' }
              }
            }
          }
        }
      }
    },
    '/api/sessions/{sessionId}': {
      get: {
        tags: ['Sessions'],
        summary: 'Return all extraction records for a session',
        parameters: [
          {
            name: 'sessionId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        responses: {
          '200': {
            description: 'Session summary',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SessionSummaryResponse' }
              }
            }
          },
          '404': {
            description: 'Session not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' }
              }
            }
          }
        }
      }
    },
    '/api/sessions/{sessionId}/expiring': {
      get: {
        tags: ['Sessions'],
        summary: 'Return documents expiring within a given number of days',
        parameters: [
          {
            name: 'sessionId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          },
          {
            name: 'withinDays',
            in: 'query',
            required: false,
            schema: { type: 'number', default: 90 }
          }
        ],
        responses: {
          '200': {
            description: 'Expiring documents',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: true
                }
              }
            }
          }
        }
      }
    },
    '/api/sessions/{sessionId}/validate': {
      post: {
        tags: ['Sessions'],
        summary: 'Run cross-document compliance validation for a session',
        parameters: [
          {
            name: 'sessionId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        responses: {
          '200': {
            description: 'Validation result',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ValidationResponse' }
              }
            }
          },
          '400': {
            description: 'Insufficient documents',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' }
              }
            }
          }
        }
      }
    },
    '/api/sessions/{sessionId}/report': {
      get: {
        tags: ['Sessions'],
        summary: 'Return a structured compliance report for a session',
        parameters: [
          {
            name: 'sessionId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        responses: {
          '200': {
            description: 'Session report',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: true
                }
              }
            }
          }
        }
      }
    }
  }
} as const;
