FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json nest-cli.json ./
COPY src ./src

EXPOSE 3000
CMD ["npm", "run", "start:dev"]
