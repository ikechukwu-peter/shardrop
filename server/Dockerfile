# The relay only forwards signaling envelopes, so it stays tiny.
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
# ws is the only runtime dependency the relay needs.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server

ENV PORT=8787
EXPOSE 8787
USER node
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server/signal.js"]
