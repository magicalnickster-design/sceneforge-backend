const { Client, GatewayIntentBits, REST, Routes, Events } = require("discord.js");
const dotenv = require("dotenv");

dotenv.config({ quiet: true });

const requiredEnv = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_GUILD_ID",
  "BACKEND_BASE_URL",
  "BOT_SHARED_SECRET"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const commands = [
  {
    name: "getkey",
    description: "Get your current SceneForge API key (or issue a new one)."
  },
  {
    name: "rotatekey",
    description: "Revoke your current key and issue a new SceneForge API key."
  }
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages]
});

async function callBackend(pathname, payload) {
  const response = await fetch(`${process.env.BACKEND_BASE_URL}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bot-Secret": process.env.BOT_SHARED_SECRET
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || `Backend request failed with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

client.once(Events.ClientReady, async () => {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
    { body: commands }
  );
  console.log(`Discord bot ready as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const shouldRotate = interaction.commandName === "rotatekey";
  if (!shouldRotate && interaction.commandName !== "getkey") {
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await callBackend("/api/tokens/issue-or-get", {
      discordUserId: interaction.user.id,
      rotate: shouldRotate,
      reason: shouldRotate ? "user_requested_rotation" : "user_requested_key"
    });

    if (!result.token) {
      await interaction.editReply(
        "You already have an active key and it cannot be re-shown for security. Use /rotatekey to create a new key."
      );
      return;
    }

    await interaction.user.send(
      `Your SceneForge API key:\n\`${result.token}\`\n\nPaste this key into your SceneForge module settings.`
    );
    await interaction.editReply("I sent your key in a DM.");
  } catch (error) {
    if (error.data?.error === "not_entitled") {
      await interaction.editReply(
        "I could not issue a key because you do not have the required Discord role yet."
      );
      return;
    }
    await interaction.editReply(`Key issuance failed: ${error.message}`);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
