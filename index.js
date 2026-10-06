require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ChannelType } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'holdtheline';
const PORT = Number(process.env.PORT || 3000);

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env');
  process.exit(1);
}

const express = require('express');
const app = express();
app.get('/', (_, res) => res.status(200).send('Bot is alive'));
app.listen(PORT, () => console.log(`Keepalive server on port ${PORT}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const authorized = new Set();
const popularCooldowns = new Map();
const popularMessages = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Unlock admin commands with password')
    .addStringOption(o => o.setName('password').setDescription('Bot password').setRequired(true)),

  new SlashCommandBuilder()
    .setName('popular')
    .setDescription('Send a message 5 times with one click')
    .addStringOption(o => o.setName('message').setDescription('Message to send 5x').setRequired(true)),

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot latency'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show available commands'),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Delete recent messages in a channel')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to clear').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('How many (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('✅ Slash commands registered globally');
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('popular:')) {
      const id = interaction.customId.replace(/^popular:/, '');
      const payload = popularMessages.get(id);
      if (!payload) {
        return interaction.reply({ content: '❌ That button expired. Use /popular again.', flags: MessageFlags.Ephemeral });
      }

      if (interaction.guildId !== payload.guildId || interaction.channelId !== payload.channelId) {
        return interaction.reply({ content: '❌ This button only works in the original channel.', flags: MessageFlags.Ephemeral });
      }

      const key = `${interaction.user.id}:${interaction.guildId}`;
      const now = Date.now();
      const last = popularCooldowns.get(key) || 0;
      if (now - last < 1500) {
        const wait = ((1500 - (now - last)) / 1000).toFixed(1);
        return interaction.reply({ content: `⏳ Wait ${wait}s before using /popular again.`, flags: MessageFlags.Ephemeral });
      }

      popularCooldowns.set(key, now);
      const channel = interaction.channel;
      for (let i = 0; i < 5; i++) {
        await channel.send(payload.text).catch(() => {});
      }
      return interaction.reply({ content: `✅ Sent "${payload.text}" 5 times.`, flags: MessageFlags.Ephemeral });
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'unlock') {
      const pw = interaction.options.getString('password', true);
      if (pw === BOT_PASSWORD) {
        authorized.add(interaction.user.id);
        return interaction.reply({ content: '✅ Unlocked!', flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: '❌ Wrong password.', flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'popular') {
      const text = interaction.options.getString('message', true).trim();
      if (!text) {
        return interaction.reply({ content: '❌ Message cannot be empty.', flags: MessageFlags.Ephemeral });
      }

      const id = `popular:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      popularMessages.set(id, {
        text,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });

      setTimeout(() => popularMessages.delete(id), 10 * 60 * 1000);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(id)
          .setLabel('Send 5x')
          .setStyle(ButtonStyle.Primary)
      );

      return interaction.reply({
        content: `📢 Click below to send this 5 times:\n> ${text}`,
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.commandName === 'ping') {
      return interaction.reply({ content: `🏓 Pong! ${client.ws.ping}ms`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'help') {
      return interaction.reply({
        content: `📋 Commands:\n• /popular <message>\n• /ping\n• /help\n• /unlock <password>\n• /clear <channel> <amount>`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.commandName === 'clear') {
      if (!authorized.has(interaction.user.id)) {
        return interaction.reply({ content: '🔒 Unlock first with /unlock', flags: MessageFlags.Ephemeral });
      }

      const channel = interaction.options.getChannel('channel', true);
      const amount = interaction.options.getInteger('amount', true);

      if (channel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: '❌ Pick a text channel.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const deleted = await channel.bulkDelete(amount, true);
        return interaction.editReply(`✅ Deleted ${deleted.size} messages.`);
      } catch (e) {
        return interaction.editReply(`❌ Failed: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('Interaction error:', e);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Error: ${e.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.login(TOKEN);
