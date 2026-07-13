const path = require("path");
const { TokenStore } = require("../src/lib/tokenStore");

async function main() {
  const dbPath =
    process.env.DB_PATH || path.join(process.cwd(), "data", "tokens.json");
  const tokenStore = new TokenStore({
    dbPath,
    tokenPepper: process.env.TOKEN_SIGNING_PEPPER || ""
  });
  await tokenStore.init();
  console.log(`Token storage initialized at ${dbPath}`);
}

main().catch((error) => {
  console.error("Failed to initialize storage:", error.message);
  process.exit(1);
});
