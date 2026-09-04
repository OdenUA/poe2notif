import pg from "npm:pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: Deno.env.get("DATABASE_URL"),
  max: 5,
});

export function q(text: string, params?: unknown[]) {
  return pool.query(text, params);
}
