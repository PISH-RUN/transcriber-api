# Use an official Node.js runtime as base image
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package.json and lock file first (to cache dependencies)
COPY package*.json ./

# Install dependencies (use `--legacy-peer-deps` if needed)
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the project (if needed)
RUN npm run build

# Expose the port your Nest app uses (default: 3000)
EXPOSE 3000

# Set Node.js memory limit as environment variable
ENV NODE_OPTIONS="--max-old-space-size=160192"

# Start the app
CMD ["node", "dist/main"]

