export function referralActorReferences(record: {
  resourceType: string;
  payload: unknown;
}): [string, string | null][];
export function referralSemanticIssues(record: {
  resourceType: string;
  payload: unknown;
  sourceActorLocalId: string;
  capturedAt: string;
  sourceRevision: number;
}): { code: string; path: string }[];
