FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS workspace
WORKDIR /app
RUN npm install --global pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/operations-web/package.json apps/operations-web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
RUN pnpm install --frozen-lockfile
COPY . .

FROM workspace AS tools
ENTRYPOINT ["sh", "/app/infra/entrypoint.sh"]
CMD ["pnpm", "db:migrate"]

FROM workspace AS api-build
RUN pnpm --filter @chs/api build
RUN CI=true pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS api
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=api-build --chown=node:node /app /app
USER node
ENTRYPOINT ["sh", "/app/infra/entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]

FROM workspace AS web-build
ARG VITE_CHS_API_BASE_URL
ARG VITE_OPERATIONS_OIDC_AUTHORIZATION_ENDPOINT
ARG VITE_OPERATIONS_OIDC_TOKEN_ENDPOINT
ARG VITE_OPERATIONS_OIDC_END_SESSION_ENDPOINT
ARG VITE_OPERATIONS_OIDC_CLIENT_ID
ARG VITE_OPERATIONS_OIDC_SCOPE="openid profile"
RUN pnpm --filter @chs/operations-web build

FROM nginx:stable-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5 AS gateway
COPY --from=web-build /app/apps/operations-web/dist /usr/share/nginx/html
COPY infra/gateway.conf.template /etc/nginx/templates/default.conf.template
