export type MigrationClient = Readonly<{
  query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
}>;

export type MigrationLogger = Readonly<{
  info: (message: string) => void;
}>;

export function migrateWithClient(options: Readonly<{
  client: MigrationClient;
  logger?: MigrationLogger;
}>): Promise<Readonly<{ applied: readonly string[] }>>;
