# Build stage — install all deps and compile TypeScript
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN npm ci --workspaces --include-workspace-root --ignore-scripts
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN npm run build --workspace @rpow/shared
RUN npm run build --workspace @rpow/server

# Runtime stage — compiled artifacts + node_modules from the build stage
FROM node:22-alpine
WORKDIR /app
COPY --from=build /repo/package.json /repo/package-lock.json /app/
COPY --from=build /repo/node_modules /app/node_modules
COPY --from=build /repo/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /repo/packages/shared/dist /app/packages/shared/dist
COPY --from=build /repo/apps/server/package.json /app/apps/server/package.json
COPY --from=build /repo/apps/server/dist /app/apps/server/dist
COPY --from=build /repo/apps/server/migrations /app/apps/server/migrations
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "apps/server/dist/server.js"]
