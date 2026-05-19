FROM node:20-bullseye-slim

ENV DATA_DIR=/tmp/sf-data
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=512

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
