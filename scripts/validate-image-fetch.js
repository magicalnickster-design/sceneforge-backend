const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const IMAGE_URL = process.env.IMAGE_URL || "";

if (!AUTH_TOKEN || !IMAGE_URL) {
  console.error("Missing AUTH_TOKEN or IMAGE_URL.");
  console.error(
    "Example: AUTH_TOKEN=token IMAGE_URL='https://delivery.us3.bfl.ai/.../sample.png' BACKEND_URL=https://sceneforge-backend.onrender.com node scripts/validate-image-fetch.js"
  );
  process.exit(1);
}

async function main() {
  const response = await fetch(`${BACKEND_URL}/api/maps/image/fetch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`
    },
    body: JSON.stringify({ imageUrl: IMAGE_URL })
  });

  const payload = await response.json().catch(() => ({}));
  console.log(JSON.stringify({ status: response.status, payload }, null, 2));
}

main().catch((error) => {
  console.error("Validation failed:", error.message);
  process.exit(1);
});
