# Official multi-arch Node image; the Supervisor builds it locally for the
# host's architecture. Node >= 22.13 provides node:sqlite, so there are no
# native modules to compile.
FROM node:22-alpine

# iputils gives a ping that reports round-trip times consistently.
RUN apk add --no-cache iputils tini

WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY app/src ./src
COPY app/public ./public

ENV NODE_ENV=production \
    PORT=8099 \
    DATA_DIR=/data

EXPOSE 8099
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]

LABEL io.hass.type="addon" \
      io.hass.name="Waterfall Alert" \
      io.hass.description="Hierarchical uptime monitoring with root-cause alerting"
