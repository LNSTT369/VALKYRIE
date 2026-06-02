#!/bin/bash
# ---------------------------------------------------------
# NIGHTWATCH3R Execution Rail - Development Launcher
# ---------------------------------------------------------

echo "🚀 Initializing Zero-Trust Execution Rail..."

# Run D1 migrations (Local)
echo "📦 Migrating Database..."
npm run db:migrate || npx wrangler d1 migrations apply nightwatcher-db --local

# Start the Cloudflare Worker
echo "⚡ Starting Edge Compute Node..."
npx wrangler dev --port 8787
