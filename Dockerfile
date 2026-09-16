# ВРЕМЕННЫЙ образ фазы Ф0: эхо-сокет, которым проверяется, проходит ли
# WebSocket-апгрейд через маршрут dockhost по пути (PROBE.md).
# Фаза Ф1 заменяет его настоящим трёхстадийным Dockerfile сервиса.
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/healthz || exit 1
USER node
CMD ["node", "server.mjs"]
