# FreshMart POS — zero runtime dependencies, so the image stays tiny.
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    POS_DB_PATH=/app/data/pos.db \
    POS_BACKUP_DIR=/app/data/backups

WORKDIR /app

# The app has no npm dependencies; only source files are copied.
COPY package.json server.js db.js auth.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

# Run as an unprivileged user, with a writable data directory for SQLite
# (WAL) and the backup snapshots.
RUN mkdir -p /app/data/backups \
  && chown -R node:node /app/data \
  && chown -R node:node /app

USER node

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
