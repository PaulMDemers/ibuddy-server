FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
ENV HOST=0.0.0.0 PORT=8082
CMD ["node", "src/server.js"]
