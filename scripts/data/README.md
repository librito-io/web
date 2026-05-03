# Seeding `book_catalog` (operator workflow)

Set `CRON_SECRET` locally (from Vercel env, since it's marked Sensitive — paste directly):

    export CRON_SECRET="<paste-from-vercel>"

Prepare an ISBN list as JSON:

    echo '{"isbns": ["9780743273565", "9780451524935"]}' > /tmp/seed.json

Trigger:

    curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
      -H "Content-Type: application/json" \
      -d @/tmp/seed.json \
      https://librito.io/api/cron/catalog-warmup

Each call processes ≤100 ISBNs (MAX_PER_RUN cap) and respects the 80/5min Open Library rate-limit budget. For larger seed lists, split + loop:

    for chunk in chunks/*.json; do
      curl -X POST ... -d @"$chunk" ...
      sleep 300
    done

Pre-launch warmup of ~3k ISBNs takes ~30 invocations + ~2.5h elapsed (mostly rate-limit pacing).
