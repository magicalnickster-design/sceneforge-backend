const DEFAULT_HOSTED_SUFFIXES = [".forge-vtt.com"];

function parseAllowedOrigins(value = "") {
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        const parsed = new URL(origin);
        if (!["https:", "http:"].includes(parsed.protocol)) {
          return null;
        }
        if (parsed.username || parsed.password) {
          return null;
        }
        return parsed.origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isLocalhost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isHostedForgeHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return DEFAULT_HOSTED_SUFFIXES.some(
    (suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix)
  );
}

function validateFoundryReturnUrl(rawUrl, options = {}) {
  const allowedOrigins = options.allowedOrigins || [];
  const allowLocalhost = options.allowLocalhost !== false;

  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return {
      ok: false,
      reason: "invalid_url",
      message: "Return URL is invalid."
    };
  }

  if (!["https:", "http:"].includes(parsed.protocol)) {
    return {
      ok: false,
      reason: "invalid_protocol",
      message: "Return URL must use http or https."
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: "invalid_credentials",
      message: "Return URL must not include credentials."
    };
  }

  const normalizedOrigin = parsed.origin;
  const isAllowlisted = allowedOrigins.includes(normalizedOrigin);
  const isForge = parsed.protocol === "https:" && isHostedForgeHostname(parsed.hostname);
  const isLocal =
    allowLocalhost && isLocalhost(parsed.hostname) && ["http:", "https:"].includes(parsed.protocol);

  if (!isAllowlisted && !isForge && !isLocal) {
    return {
      ok: false,
      reason: "unapproved_origin",
      message: "Return URL origin is not approved."
    };
  }

  return {
    ok: true,
    normalizedUrl: parsed.toString(),
    origin: normalizedOrigin
  };
}

function appendQueryParam(urlString, key, value) {
  const parsed = new URL(urlString);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

function appendHashParams(urlString, params = {}) {
  const parsed = new URL(urlString);
  const hashParams = new URLSearchParams(params);
  parsed.hash = hashParams.toString();
  return parsed.toString();
}

function isApprovedExchangeOrigin(origin, options = {}) {
  if (!origin) {
    return false;
  }
  const probeUrl = `${String(origin).replace(/\/+$/, "")}/`;
  const validation = validateFoundryReturnUrl(probeUrl, options);
  return validation.ok;
}

module.exports = {
  parseAllowedOrigins,
  validateFoundryReturnUrl,
  appendQueryParam,
  appendHashParams,
  isApprovedExchangeOrigin
};
