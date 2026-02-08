import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? { rejectUnauthorized: false }
    : process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : undefined,
});

export default pool;
