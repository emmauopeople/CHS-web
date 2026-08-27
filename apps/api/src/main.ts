import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './database.js';
import { createShutdownHandler } from './shutdown.js';

const config = loadConfig();
const database = createDatabase(config);
const app = await buildApp({ config, database });

const shutdown = createShutdownHandler({
  close: async () => app.close(),
  logStart: (signal) => app.log.info({ signal }, 'Shutting down'),
  logFailure: (signal, error) =>
    app.log.error({ err: error, signal }, 'API shutdown failed'),
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'API failed to start');
  await app.close();
  process.exitCode = 1;
}
