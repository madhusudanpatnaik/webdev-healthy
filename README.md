# HealthyBento — Tiffin Ledger CRM

![Node.js](https://img.shields.io/badge/Node.js-stdlib_only-339933?style=flat-square&logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/deps-zero-brightgreen?style=flat-square)
![Storage](https://img.shields.io/badge/storage-JSON_file-informational?style=flat-square)
![Region](https://img.shields.io/badge/region-Visakhapatnam,_IN-orange?style=flat-square)

A warm, editorial cockpit for daily lunch-box dispatch, subscribers, and kitchen prep — built for a tiffin service in Visakhapatnam, Andhra Pradesh.

Zero external dependencies. Everything runs on the Node.js standard library. State is an atomically-written JSON file — no database to install, no ORM to learn, no cloud bill.

## What's in the box

- **REST API + static server** in a single `server.js` (Node.js `http` module)
- **Atomic file persistence** to `data/db.json` (tmp-file + rename, so no half-writes survive a crash)
- **Seed data** in `data/seed.json` loaded on first boot
- **Static frontend** (`index.html` + `css/` + `js/`) served from the same process
- **Test suite** in `tests/`

## Domain model

| Entity | Purpose |
|---|---|
| **zones** | Delivery zones within the city |
| **templates** | Reusable meal templates (veg / nonveg) |
| **addons** | Optional add-on items per order |
| **customers** | Subscriber records |
| **orders** | Daily dispatch orders with a 5-stage status |
| **kitchenChecklist** | Prep-station tick sheet for the kitchen |

**Order lifecycle:** `received → prep → qc → transit → delivered`

**Diet types:** `veg`, `nonveg`

## Running locally

**Prerequisites:** Node.js 18+ (nothing else)

```bash
git clone https://github.com/madhusudanpatnaik/webdev-healthy
cd webdev-healthy
node server.js
```

Default port is `8090`. Override with:

```bash
PORT=3000 node server.js
```

Open `http://localhost:8090` in a browser.

## Structure

```
webdev-healthy/
├── server.js          # REST API + static file server (all in one)
├── index.html         # Frontend entry
├── css/               # Editorial styling
├── js/                # Client-side logic
├── data/
│   ├── db.json        # Live database (atomic writes)
│   └── seed.json      # Bootstrap data
└── tests/             # Test suite
```

## Data persistence contract

`data/db.json` is the source of truth. Writes go through `saveDatabase()` which:

1. Writes to a unique `.tmp` file (`db.json.<timestamp>.<random>.tmp`)
2. Atomically renames the tmp file over `db.json` (POSIX rename is atomic on same filesystem)

If a write fails mid-way, `db.json` still holds the last consistent state — the tmp file is orphaned but harmless.

## Why zero dependencies

Kitchen dispatch runs 7 days a week. A CRM that stops working because npm updated a semver range on the day the wholesaler cancelled is a CRM that just cost you a day of orders. Node's stdlib doesn't move.

## License

Not currently specified. Contact the owner before reuse.
