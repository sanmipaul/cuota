# Cuota agent. Runs anywhere Docker runs. Keeps its SQLite database at DB_PATH; set
# DATABASE_URL to back it up to Postgres on hosts without a persistent disk.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/app/data/cuota.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /app/data
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
EXPOSE 8787
CMD ["node", "--no-warnings=ExperimentalWarning", "--import", "tsx", "src/main.ts"]
