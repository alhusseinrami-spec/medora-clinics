# Performance test (Release 7)

**Data:** the synthetic demo plus `perf/load_data.js`: 20,000 extra synthetic patients and about 16,000 appointments in the Cedar medical center (57,000 rows in all). Development container, PostgreSQL 16, one API process, no caching.

**How to repeat:** `npm run db:reset && npm run db:presets`, start the API, `npm run db:seed`, `node perf/load_data.js`, then `node perf/run.mjs 200 10` (200 requests per endpoint, 10 at a time).

## What was found and fixed

| Problem | Cause | Fix | Before | After (one request) |
|---|---|---|---|---|
| Patient search slow | Row-level security functions ran their permission lookups once per row | Permission context is loaded once per transaction and cached (`app_ctx_load`, migration 011); the cache resets whenever memberships or permissions change | 3.9 s | 0.17 s |
| Dashboard summary slow | Same as above, plus a "today" filter that could not use an index | Today's window is computed in the workspace time zone first, then matched as a range; new indexes on appointments and patients by workspace | 20 s | 0.22 s |

## Results after the fixes (10 requests at a time, milliseconds)

| Endpoint | p50 | p95 | max | errors |
|---|---|---|---|---|
| Patient search (receptionist, 20k patients) | 472 | 599 | 675 | 0 |
| Patient list (doctor) | 34 | 54 | 68 | 0 |
| Patient file | 17 | 26 | 33 | 0 |
| Calendar week, all doctors | 51 | 69 | 87 | 0 |
| Waiting room | 14 | 21 | 29 | 0 |
| Dashboard summary (doctor) | 591 | 696 | 730 | 0 |
| Patient timeline | 22 | 31 | 43 | 0 |
| Financial overview, year | 35 | 53 | 75 | 0 |
| Admin workspaces list | 579 | 740 | 953 | 0 |
| Admin overview | 13 | 24 | 37 | 0 |

With ten requests at once each one waits for the others, which is why these are higher than the single-request times above.

Every screen answers in under one second at the 95th percentile with ten people working at once on a center with 20,000 patients. Search and the dashboard are the heaviest because row-level security still checks each candidate patient; that is the price of enforcing privacy in the database itself.

**Not measured:** a real server, many API processes, or more than 20,000 patients in one workspace. Next steps if a center grows past that: a trigram index for name search and a materialised count for the dashboard.
