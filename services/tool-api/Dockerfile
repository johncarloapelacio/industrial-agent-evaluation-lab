FROM node:26-alpine AS build
WORKDIR /app/services/tool-api
COPY services/tool-api/package*.json ./
RUN npm ci
COPY services/tool-api/tsconfig.json ./
COPY services/tool-api/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine
ENV NODE_ENV=production PORT=3001 HOST=0.0.0.0 SCHEMA_PATH=/app/database/schema.sql
WORKDIR /app/services/tool-api
COPY --from=build --chown=node:node /app/services/tool-api/package*.json ./
COPY --from=build --chown=node:node /app/services/tool-api/node_modules ./node_modules
COPY --from=build --chown=node:node /app/services/tool-api/dist ./dist
COPY --chown=node:node database/schema.sql /app/database/schema.sql
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
