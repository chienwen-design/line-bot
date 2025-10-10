import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: "postgresql://root:d1vfzSyFL1oiKQc6zv2jVpwasKboEOeu@dpg-d3hkt1buibrs73b0h4k0-a.singapore-postgres.render.com/database_uww8",
  ssl: { rejectUnauthorized: false },
});

async function fixColumns() {
  await pool.query(`
    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS waiting_for_phone BOOLEAN DEFAULT FALSE;
  `);
  await pool.query(`
    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS pending_phone VARCHAR(255);
  `);
  console.log("✅ 欄位補上成功！");
  process.exit(0);
}

fixColumns();
