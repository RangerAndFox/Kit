# Kit Bolt — Railway Deployment
# Persistent Node.js process for Slack Socket Mode
# No cold starts, no timeouts, runs 24/7

FROM node:22-slim

# Archive media worker: frame extraction, GIF generation, and duration probes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps at /app so both /app/bolt/src/** and /app/src/lib/**
# can resolve them via Node's upward node_modules lookup.
COPY bolt/package.json bolt/package-lock.json ./
RUN npm ci --omit=dev

# Shared agent code (imported by bolt handlers)
COPY src/lib/ ./src/lib/

# Bolt app source
COPY bolt/src/ ./bolt/src/
COPY bolt/tsconfig.json ./bolt/

# Static assets (e.g. the NDA paperwork template) read at runtime
COPY bolt/assets/ ./bolt/assets/

WORKDIR /app/bolt

# The official Node image provides an unprivileged `node` user. All runtime
# files are read-only application assets; Bolt does not need root privileges.
USER node

# Probe the app's real /health endpoint (Slack-connectivity watchdog) —
# the old `process.exit(0)` always passed regardless of app state.
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/app.ts"]
