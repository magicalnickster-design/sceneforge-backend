const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

if (!AUTH_TOKEN) {
  console.error("Missing AUTH_TOKEN env var.");
  console.error(
    "Example: AUTH_TOKEN=your_token BACKEND_URL=https://sceneforge-backend.onrender.com node scripts/validate-generate.js"
  );
  process.exit(1);
}

async function callGenerate(body) {
  const response = await fetch(`${BACKEND_URL}/api/maps/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

async function main() {
  console.log("== Success-path generation attempt ==");
  const successAttempt = await callGenerate({
    prompt: "top-down fantasy market square battle map",
    imageCount: 1
  });
  console.log(JSON.stringify(successAttempt, null, 2));

  console.log("== Forced bad request to upstream (negative width) ==");
  const badAttempt = await callGenerate({
    prompt: "top-down fantasy market square battle map",
    width: -1,
    imageCount: 1
  });
  console.log(JSON.stringify(badAttempt, null, 2));
}

main().catch((error) => {
  console.error("Validation script failed:", error.message);
  process.exit(1);
});
