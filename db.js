require('dotenv').config();

const { Pool } = require('pg');

// Prefer a DATABASE_URL if provided (useful for remote/production),
// otherwise read individual DB_ env vars for local development.
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      // Supabase / many hosted Postgres providers require SSL
      ssl: {
        rejectUnauthorized: false,
      },
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected idle client error', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
