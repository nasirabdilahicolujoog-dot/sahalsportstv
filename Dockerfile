FROM node:24-alpine
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV TRUST_PROXY_HOPS=1
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY backend/src ./src
COPY backend/scripts ./scripts
COPY backend/schema.sql ./
USER node
EXPOSE 8090
CMD ["node", "src/server.js"]
