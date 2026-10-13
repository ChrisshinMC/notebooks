FROM node:22-bookworm
WORKDIR /app/competitor-recorder
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY competitor-recorder/package.json competitor-recorder/pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate && pnpm install --prod --frozen-lockfile && pnpm exec playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY competitor-recorder/src ./src
COPY competitor-recorder/hosted ./hosted
COPY competitor-hosted-app/research-api/openrouter-client.mjs /app/competitor-hosted-app/research-api/openrouter-client.mjs
COPY competitor-hosted-runner/*.mjs /app/competitor-hosted-runner/
RUN mkdir /data && chown node:node /data
USER node
ENV PORT=9000 CAPTURE_DATA_DIR=/data
EXPOSE 9000
VOLUME /data
CMD ["node","/app/competitor-hosted-runner/start.mjs"]
