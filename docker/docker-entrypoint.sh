#!/bin/bash

# Default STORAGE_DIR if not set
export STORAGE_DIR="${STORAGE_DIR:-/app/server/storage}"

# Seed storage on first run if volume is empty
if [ ! -f "$STORAGE_DIR/anythingllm.db" ] && [ -d "/app/seed-storage" ]; then
  echo "Seeding storage from initial data..."
  mkdir -p "$STORAGE_DIR"
  cp -r /app/seed-storage/. "$STORAGE_DIR/"
  echo "Storage seeded successfully."
fi

# Reset vector DB if RESET_VECTOR_DB=1 (fixes Mac->Linux LanceDB incompatibility)
if [ "$RESET_VECTOR_DB" = "1" ]; then
  echo "RESET_VECTOR_DB=1 detected. Clearing LanceDB and document vectors..."
  rm -rf "$STORAGE_DIR/lancedb/cerebro.lance"
  node -e "
    const { PrismaClient } = require('/app/server/node_modules/@prisma/client');
    const p = new PrismaClient({ datasources: { db: { url: 'file:' + process.env.STORAGE_DIR + '/anythingllm.db' } } });
    p.workspaces.findFirst({ where: { slug: 'cerebro' } })
      .then(ws => {
        if (!ws) { console.log('workspace not found'); return p.\$disconnect(); }
        return p.workspace_documents.deleteMany({ where: { workspaceId: ws.id } })
          .then(r => { console.log('workspace_documents deleted:', r.count); })
          .then(() => p.\$executeRawUnsafe('DELETE FROM document_vectors'))
          .then(() => { console.log('document_vectors cleared'); })
          .then(() => p.\$disconnect());
      }).catch(e => { console.error(e); process.exit(1); });
  "
  echo "Vector DB reset complete. Set RESET_VECTOR_DB=0 in Railway after re-uploading documents."
fi

# Check if STORAGE_DIR is set
if [ -z "$STORAGE_DIR" ]; then
    echo "================================================================"
    echo "⚠️  ⚠️  ⚠️  WARNING: STORAGE_DIR environment variable is not set! ⚠️  ⚠️  ⚠️"
    echo ""
    echo "Not setting this will result in data loss on container restart since"
    echo "the application will not have a persistent storage location."
    echo "It can also result in weird errors in various parts of the application."
    echo ""
    echo "Please run the container with the official docker command at"
    echo "https://docs.anythingllm.com/installation-docker/quickstart"
    echo ""
    echo "⚠️  ⚠️  ⚠️  WARNING: STORAGE_DIR environment variable is not set! ⚠️  ⚠️  ⚠️"
    echo "================================================================"
fi

{
  cd /app/server/ &&
    # Disable Prisma CLI telemetry (https://www.prisma.io/docs/orm/tools/prisma-cli#how-to-opt-out-of-data-collection)
    export CHECKPOINT_DISABLE=1 &&
    npx prisma generate --schema=./prisma/schema.prisma &&
    npx prisma migrate deploy --schema=./prisma/schema.prisma &&
    node /app/server/index.js
} &
{ node /app/collector/index.js; } &
wait -n
exit $?