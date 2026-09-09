# Builds the React client, then runs it behind the Express server (which
# also serves the built client as static files — see server/index.js) in a
# slim runtime image. Two stages so the final image doesn't carry the
# client's node_modules or any devDependencies.
#
# Persistence: the app stores its state (treasury, ventures, sessions,
# daily reports) as JSON files under whatever JARVIS_DATA_DIR points at
# (default server/data/, inside the container's writable layer). On a
# platform like Railway, mount a persistent Volume and set
# JARVIS_DATA_DIR to its mount path (e.g. /data) — see README.md's
# "Deploy to Railway" section — otherwise every redeploy starts from a
# fresh $100 treasury.

FROM node:20-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev --prefix server
COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server/index.js"]
