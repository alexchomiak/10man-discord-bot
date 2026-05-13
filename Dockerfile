FROM node:20-bookworm-slim

WORKDIR /app
ARG BUILD_VERSION=dev
ARG BUILD_DATE=unknown
ENV BUILD_VERSION=$BUILD_VERSION
ENV BUILD_DATE=$BUILD_DATE
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev \
  && npm cache clean --force

COPY src ./src
RUN mkdir -p /app/data \
  && chown -R node:node /app

USER node

CMD ["npm", "start"]
