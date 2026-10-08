# Use a lightweight Node.js image
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY packages/remote-gateway/package.json packages/remote-gateway/package-lock.json* ./

# Install ALL dependencies (including devDependencies like typescript)
RUN npm install

# Copy source code and tsconfig
COPY packages/remote-gateway/src ./src
COPY packages/remote-gateway/tsconfig.json ./tsconfig.json
COPY packages/remote-gateway/guacamole-lite.d.ts ./guacamole-lite.d.ts

# Build the TypeScript code
RUN npm run build

# Remove development dependencies after build
RUN npm prune --production

# --- Production Stage ---
FROM node:20-alpine

WORKDIR /app

# Copy built code and node_modules from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY packages/remote-gateway/package.json ./package.json

# --- Add patch application steps ---
# Copy the patches directory from the build context (relative to project root)
COPY patches ./patches

# Install patch-package temporarily to apply patches
# Note: We install it here again in case prune removed it, and ensure it's available in the final stage.
# Using --no-save as we don't need it in the final package.json dependencies.
RUN npm install patch-package --no-save

# Apply patches
RUN npx patch-package --error-on-fail

# Uninstall patch-package after applying to keep the image clean
RUN npm uninstall patch-package
# --- End patch application steps ---

# Expose the API and WebSocket ports
# These will be configurable via environment variables, but good to have defaults
EXPOSE 9090
EXPOSE 8081

# Command to run the application
CMD ["node", "dist/server.js"]