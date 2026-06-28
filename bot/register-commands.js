const { REST, Routes } = require("discord.js");
const dotenv = require("dotenv");

dotenv.config({ quiet: true });

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

async function register() {
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_GUILD_ID) {
    throw new Error("DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID are required.");
  }

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
    { body: commands }
  );
  console.log("Slash commands registered.");
}

register().catch((error) => {
  console.error("Failed to register commands:", error.message);
  process.exit(1);
});
