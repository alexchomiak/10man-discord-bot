FROM node:20-alpine

WORKDIR /app
ARG BUILD_VERSION=dev
ARG BUILD_DATE=unknown
ENV BUILD_VERSION=$BUILD_VERSION
ENV BUILD_DATE=$BUILD_DATE

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
RUN mkdir -p /app/data

CMD ["npm", "start"]
