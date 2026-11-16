FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY backend/src ./src
COPY backend/scripts ./scripts
COPY backend/schema.sql ./
USER node
EXPOSE 8090
CMD ["node", "src/server.js"]
