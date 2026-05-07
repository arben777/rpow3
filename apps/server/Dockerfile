# Build stage
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN npm ci --workspaces --include-workspace-root
RUN npm run build --workspace @rpow/shared
RUN npm run build --workspace @rpow/server

# Runtime stage
FROM node:22-alpine
WORKDIR /app
COPY --from=build /repo/package.json /repo/package-lock.json /app/
COPY --from=build /repo/packages/shared /app/packages/shared
COPY --from=build /repo/apps/server /app/apps/server
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "apps/server/dist/server.js"]
