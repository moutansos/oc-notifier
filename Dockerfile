FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS install
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source files
FROM base AS release
COPY --from=install /app/node_modules node_modules
COPY src ./src
COPY package.json ./

# Run the app
USER bun
ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD ["--config", "/config/config.json"]
