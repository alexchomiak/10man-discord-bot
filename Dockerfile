FROM node:20-alpine

WORKDIR /app
ARG BUILD_VERSION=dev
ENV BUILD_VERSION=$BUILD_VERSION

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
RUN mkdir -p /app/data

CMD ["npm", "start"]
