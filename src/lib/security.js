const crypto = require("crypto");

function generateApiToken() {
  return `sf_${crypto.randomBytes(32).toString("base64url")}`;
}

function hashToken(token, pepper = "") {
  return crypto
    .createHash("sha256")
    .update(`${pepper}:${token}`)
    .digest("hex");
}

function tokenPreview(token) {
  return String(token || "").slice(-6);
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
  generateApiToken,
  hashToken,
  tokenPreview,
  safeCompare
};
