require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client, GatewayIntentBits } = require('discord.js');

const channelIds = ['1539106867161341972', '1539106898677080074']; // gamedev, general

(async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_TOKEN_CLAUDE);

  for (const id of channelIds) {
    const channel = await client.channels.fetch(id);
    const webhook = await channel.createWebhook({ name: 'usage-coach' });
    console.log(`${channel.name} (${id}): ${webhook.url}`);
  }

  client.destroy();
})();
