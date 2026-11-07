// Applies prisma/rls.sql to the database. Runs the whole file in one simple
// query (pg's simple protocol allows multiple statements, including the DO
// blocks). Run after `prisma migrate deploy`.
//
//   npm run rls -w @cronapp/database
//
// Requires DATABASE_URL in the environment (load your .env first).

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'rls.sql'), 'utf8');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
    console.log('✔ RLS policies applied.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
