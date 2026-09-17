# Три стадии, по образцу сайта, но короче: сборка — tsc, рантайм — node.
# Этот файл собирает dockhost прямо из ветки main, реестра образов нет.
#
# Node 24, а не 20, как у сайта: LTS-поддержка ветки 20 кончилась в апреле 2026,
# заводить новый сервис на мёртвой ветке незачем (сайт догоняет отдельной
# задачей). ARG для публичных ключей здесь не нужны — в сервисе публичных ключей
# нет вообще, всё приходит переменными окружения контейнера.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm run build
# Дальше в образ уезжают только dist и node_modules, поэтому dev-зависимости
# (typescript, vitest, tsx) выбрасываем здесь же.
RUN npm prune --omit=dev

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Непривилегированный пользователь node (uid 1000) уже есть в образе.
USER node

EXPOSE 8080

# Внутри контейнера префикса маршрута нет, поэтому путь без /board-ws.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

CMD ["node", "dist/index.js"]
