# API image (build context: repo root). Runs the TypeScript sources with tsx
# (a runtime dependency): Node's built-in type stripping can't run them
# because the code uses TypeScript parameter properties.
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ENV NODE_ENV=production
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY api/tsconfig.json ./
COPY api/src ./src
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/server.ts"]
