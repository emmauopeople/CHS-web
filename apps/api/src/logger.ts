import type { LoggerOptions } from 'pino';

import type { AppConfig } from './config.js';

export function loggerOptions(config: AppConfig): LoggerOptions {
  return {
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body',
        'res.headers["set-cookie"]',
        '*.accessToken',
        '*.refreshToken',
        '*.password',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url,
          hostname: request.hostname,
          remoteAddress: request.remoteAddress,
          remotePort: request.remotePort,
        };
      },
      res(response) {
        return { statusCode: response.statusCode };
      },
    },
  };
}
