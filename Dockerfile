FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY readiness.config.json ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 STATE_DIR=/data COOKIE_SECURE=1 TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
