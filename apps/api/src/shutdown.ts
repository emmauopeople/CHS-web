export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export type ShutdownDependencies = Readonly<{
  close: () => Promise<void>;
  logStart: (signal: ShutdownSignal) => void;
  logFailure: (signal: ShutdownSignal, error: unknown) => void;
  setExitCode: (code: 0 | 1) => void;
}>;

export function createShutdownHandler(dependencies: ShutdownDependencies) {
  let pendingShutdown: Promise<void> | undefined;

  return (signal: ShutdownSignal): Promise<void> => {
    if (pendingShutdown) return pendingShutdown;

    dependencies.logStart(signal);
    pendingShutdown = dependencies.close().then(
      () => dependencies.setExitCode(0),
      (error: unknown) => {
        dependencies.logFailure(signal, error);
        dependencies.setExitCode(1);
      },
    );
    return pendingShutdown;
  };
}
