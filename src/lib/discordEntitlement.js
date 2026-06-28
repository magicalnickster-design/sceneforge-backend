function missingDiscordConfig(env) {
  return (
    !env.DISCORD_BOT_TOKEN ||
    !env.DISCORD_GUILD_ID ||
    !env.DISCORD_REQUIRED_ROLE_ID
  );
}

async function verifyDiscordRole({
  discordUserId,
  env = process.env,
  fetchImpl = fetch
}) {
  if (missingDiscordConfig(env)) {
    return {
      ok: false,
      statusCode: 503,
      error: "discord_not_configured",
      message:
        "DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, and DISCORD_REQUIRED_ROLE_ID are required."
    };
  }

  const endpoint = `https://discord.com/api/v10/guilds/${encodeURIComponent(
    env.DISCORD_GUILD_ID
  )}/members/${encodeURIComponent(discordUserId)}`;

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`
      }
    });
  } catch {
    return {
      ok: false,
      statusCode: 503,
      error: "discord_unreachable",
      message: "Unable to reach Discord API."
    };
  }

  if (response.status === 404) {
    return {
      ok: false,
      statusCode: 403,
      error: "not_entitled",
      message: "User is not a member of the configured Discord guild."
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status === 429 ? 503 : 502,
      error: "discord_api_error",
      message: `Discord API request failed with status ${response.status}.`
    };
  }

  const member = await response.json();
  const roles = Array.isArray(member.roles) ? member.roles : [];
  if (!roles.includes(env.DISCORD_REQUIRED_ROLE_ID)) {
    return {
      ok: false,
      statusCode: 403,
      error: "not_entitled",
      message: "User does not have the required Discord role."
    };
  }

  return {
    ok: true
  };
}

module.exports = {
  verifyDiscordRole
};
