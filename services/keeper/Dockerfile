FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @landed/keeper...
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@landed/keeper", "start"]
