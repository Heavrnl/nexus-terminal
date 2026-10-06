FROM node:20 AS builder

WORKDIR /app


# Copy root package files including the lock file
COPY package.json package-lock.json ./

# Copy workspace package.json files to ensure npm ci works correctly in monorepo
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/remote-gateway/package.json ./packages/remote-gateway/

# Install dependencies (using install instead of ci for potential armv7/alpine compatibility issues)
RUN npm install

COPY packages/backend/src ./packages/backend/src
COPY packages/backend/tsconfig.json ./packages/backend/
COPY packages/backend/html-presets ./packages/backend/html-presets

RUN npm run build --workspace=@nexus-terminal/backend


FROM node:20-alpine


# Install build dependencies including setuptools for node-gyp
RUN apk add --no-cache --virtual .build-deps python3 py3-setuptools make g++

WORKDIR /app


COPY packages/backend/package.json ./package.json
COPY package-lock.json ./package-lock.json
RUN npm install --omit=dev --prefer-offline

COPY --from=builder /app/packages/backend/dist ./dist
COPY --from=builder /app/packages/backend/src/locales ./dist/locales
COPY --from=builder /app/packages/backend/html-presets ./html-presets

RUN apk del .build-deps



EXPOSE 3001


CMD ["node", "dist/index.js"]
