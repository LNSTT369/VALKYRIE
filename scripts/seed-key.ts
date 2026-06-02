/**
 * NIGHTWATCH3R API Key Seeder
 */
import { execSync } from "child_process";

const sql = "INSERT INTO api_keys (key_id, token_hash, credibility_weight) VALUES ('default', 'dev-key-hash-stub', 1.0) ON CONFLICT(key_id) DO NOTHING;";

try {
  execSync("npx wrangler d1 execute nightwatcher-db --local --command \"" + sql + "\"");
  console.log("✅ Seed successful. Development key is active.");
} catch (error) {
  console.error("❌ Failed to seed database.");
}
