import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ override: true });

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 5433),
  database: process.env.DB_NAME || "ai_platform",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "1234",
  max: 10,
  idleTimeoutMillis: 30000,
});

export const query = (text, params) => pool.query(text, params);

export const testConnection = async () => {
  try {
    const result = await pool.query("SELECT NOW()");
    console.log("✅ DB bağlantısı başarılı:", result.rows[0]);
    return true;
  } catch (error) {
    console.error("❌ DB bağlantısı BAŞARISIZ:", error.message);
    return false;
  }
};

export default pool;