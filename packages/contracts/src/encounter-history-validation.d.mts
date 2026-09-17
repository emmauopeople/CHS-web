export function encounterHistoryActorReferences(record: {
  resourceType: string;
  payload: unknown;
}): [string, string | null][];
export function encounterHistorySemanticIssues(record: {
  resourceType: string;
  payload: unknown;
  sourceActorLocalId: string;
  capturedAt: string;
  sourceRevision: number;
}): { code: string; path: string }[];
