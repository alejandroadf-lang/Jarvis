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

# Circadian (ventures/circadian) is a Python app this server starts and serves
# at /circadian — see server/circadian.js. Its dependencies go in their own
# virtualenv, before the app code, so a code change doesn't reinstall them.
# ca-certificates because the slim image has none: Node carries its own, but
# Python's HTTPS to WHOOP would fail certificate checks without them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY ventures/circadian/src/requirements.txt /tmp/circadian-requirements.txt
RUN python3 -m venv /opt/circadian \
 && /opt/circadian/bin/pip install --no-cache-dir -r /tmp/circadian-requirements.txt

COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev --prefix server
COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist
COPY ventures/circadian/ ./ventures/circadian/

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server/index.js"]
