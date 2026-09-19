# Remote MCP server (Streamable HTTP) for the Claude connector — mcp.diagrams.so.
# Its own Elastic Beanstalk Docker environment, the same EB pattern the app / API /
# docs envs already use. Holds no secrets and no state: each request is authenticated
# by the OAuth Bearer it forwards to the Diagrams API (see src/http.ts).
#
# Build from the repo root:
#   docker build -f deploy/Dockerfile -t <registry>/diagrams-mcp:<tag> .
# Runtime env (set on the EB environment): MCP_PUBLIC_URL, OAUTH_ISSUER,
# DIAGRAMS_API_BASE. Listens on 8080 (matches deploy/Dockerrun.aws.json
# ContainerPort); GET /health is the ALB health check.

# ---- build: compile TS -> dist (needs dev deps: typescript) ----------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts so the `prepare` (tsc) lifecycle doesn't run before src exists;
# we invoke the build explicitly once the sources are in.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime: prod deps + compiled output only -----------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
# Hosted path hardening: never start the interactive device auto-login (there is no
# terminal and each request is already authenticated by its forwarded Bearer).
ENV DIAGRAMS_NO_AUTO_LOGIN=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
# Liveness: the ALB uses GET /health; this HEALTHCHECK gives docker/EB the same signal.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Exec form so SIGTERM reaches node directly (clean EB rolling-deploy shutdown).
CMD ["node", "dist/http.js"]
