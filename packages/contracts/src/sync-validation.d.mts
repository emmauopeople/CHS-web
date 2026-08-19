export type ContractValidationIssue = Readonly<{
  code: string;
  path: string;
}>;

export type ContractValidationResult =
  | Readonly<{ valid: true; issues: readonly [] }>
  | Readonly<{
      valid: false;
      issues: readonly ContractValidationIssue[];
    }>;

export function validateSyncBatchRequest(
  value: unknown,
): ContractValidationResult;

export function validateSyncBatchResponse(
  value: unknown,
): ContractValidationResult;
