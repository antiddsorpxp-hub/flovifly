#!/usr/bin/env sh
set -eu
mkdir -p data/backups
if [ -f data/db.json ]; then cp data/db.json "data/backups/db-$(date +%Y%m%d-%H%M%S).json"; echo "Backup saved to data/backups"; else echo "No data/db.json yet"; fi
