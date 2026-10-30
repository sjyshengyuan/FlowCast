FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node remote/hub.mjs ./remote/hub.mjs
COPY --chown=node:node lib/remote-protocol.mjs ./lib/remote-protocol.mjs
USER node
EXPOSE 8080
CMD ["node", "remote/hub.mjs"]
