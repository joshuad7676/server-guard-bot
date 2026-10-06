// server-guard-bot — RAID PROTECTION + LAYOUT RESET
// discord.js v14 | Node 18+ | pure JS (no native deps)
// Run: node index.js

require('dotenv').config();
const fs = require('fs');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  GuildVerificationLevel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');

// ---------- ENV ----------
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = (process.env.GUILD_ID || '').trim();
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'holdtheline';
const MODLOG_NAME = process.env.MODLOG_CHANNEL || 'mod-log';
const PORT = Number(process.env.PORT || 3000);
const DRY_RUN = String(process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const WHITELIST_IDS = String(process.env.WHITELIST_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const OWNER_ID = (process.env.OWNER_ID || '').trim();

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN / CLIENT_ID in .env');
  process.exit(1);
}

// ---------- KEEP-ALIVE (for Render/UptimeRobot later) ----------
const app = express();
app.get('/', (req, res) => res.status(200).send('Bot is alive'));
const server = app.listen(PORT, () => console.log(`Keep-alive server on port ${PORT}`));
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use (another bot still running?).`);
    console.error(`Fix: stop the other "node index.js" window, OR set a different PORT in .env (e.g. PORT=3001) and restart.`);
    process.exit(1);
  }
  throw err;
});

// ---------- STATE ----------
const authorized = new Set();          // user IDs that entered password
const pendingNuke = new Map();         // userId -> { type, category }
const pendingReset = new Map();        // userId -> { name }
const joinTimes = [];                  // timestamps (ms) of recent joins
const msgTimes = new Map();            // userId -> [timestamps]
const popularCooldowns = new Map();     // `${userId}:${guildId}` -> timestamp
const popularMessages = new Map();      // buttonId -> { text, guildId, channelId }
let isLocked = false;
let savedOverwrites = new Map();       // channelId -> { send: true|false|null, connect: true|false|null } | null
let savedVerification = null;
let lastAutoLock = 0;

// ---------- RAID PROTECTION SETTINGS (saved to protect.json) ----------
const PROTECT_FILE = 'protect.json';
const protect = {
  antiSpam: true,
  antiLink: false,
  antiMention: true,
  antiRaid: true,
  punishSpam: 'timeout',   // delete | timeout | kick | ban
  punishLink: 'delete',    // delete | timeout | kick | ban
  punishMention: 'timeout',
  timeoutMinutes: 10,
  minAccountAgeDays: 0,    // 0 = off, else flag accounts younger than X days
};
try {
  if (fs.existsSync(PROTECT_FILE)) {
    Object.assign(protect, JSON.parse(fs.readFileSync(PROTECT_FILE, 'utf8')));
  }
} catch (e) { console.error('protect.json load:', e.message); }
function saveProtect() {
  try { fs.writeFileSync(PROTECT_FILE, JSON.stringify(protect, null, 2)); } catch (e) {}
}
function hasLink(text) {
  if (!text) return false;
  return /https?:\/\/|www\.|discord\.gg|discord\.com\/invite|discordapp\.com\/invite|\b\w+\.(com|net|org|gg|io|xyz|link|tv)\b/i.test(text);
}
async function doPunish(member, msg, action, reason) {
  const mins = protect.timeoutMinutes || 10;
  try { await msg.delete().catch(() => {}); } catch {}
  try {
    if (action === 'delete') return 'deleted message';
    if (action === 'timeout') { await member.timeout(mins * 60 * 1000, reason); return `timed out ${mins}m`; }
    if (action === 'kick') { await member.kick(reason); return 'kicked'; }
    if (action === 'ban') { await member.ban({ reason }); return 'banned'; }
  } catch (e) {
    console.error('punish failed:', e.message);
    return 'punish failed: ' + e.message;
  }
  return action;
}

// ---------- CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // needed for join logging (enable "Server Members Intent" in portal)
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // needed for ping phrase + spam check
    GatewayIntentBits.GuildModeration, // needed for timeouts
  ],
});

// ---------- HELPERS ----------
function isWhitelisted(member) {
  if (!member) return false;
  if (member.id === member.guild?.ownerId) return true;
  if (WHITELIST_IDS.includes(member.id)) return true;
  const p = member.permissions;
  if (p.has(PermissionFlagsBits.Administrator)) return true;
  if (p.has(PermissionFlagsBits.ManageGuild)) return true; // "Manage Server"
  return false;
}

function isUnlocked(userId) {
  return authorized.has(userId);
}

async function getModLog(guild) {
  let ch = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.name === MODLOG_NAME
  );
  if (!ch) {
    ch = await guild.channels.create({
      name: MODLOG_NAME,
      type: ChannelType.GuildText,
      reason: 'Create mod-log channel',
    });
  }
  return ch;
}

async function log(guild, text) {
  try {
    const ch = await getModLog(guild);
    await ch.send(text.length > 1900 ? text.slice(0, 1900) : text);
  } catch (e) {
    console.error('mod-log failed:', e.message);
  }
}

function pingMe(guild) {
  if (OWNER_ID) return `<@${OWNER_ID}>`;
  if (WHITELIST_IDS.length) return WHITELIST_IDS.map(id => `<@${id}>`).join(' ');
  return `<@${guild.ownerId}>`;
}

// Only your server, never DMs. Returns true if OK, else replies + returns false.
async function requireMyGuild(interaction) {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: '❌ This bot only works inside a server, not in DMs.', flags: MessageFlags.Ephemeral });
    return false;
  }
  return true;
}

async function requireUnlock(interaction) {
  if (!isUnlocked(interaction.user.id)) {
    await interaction.reply({
      content: '🔒 Locked. Ping me with "i wanna use you please" or use `/unlock password:xxx` first.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  return true;
}

// ---------- LOCKDOWN / UNLOCK ----------
async function doLockdown(guild, reason) {
  const everyone = guild.roles.everyone;
  savedOverwrites = new Map();
  savedVerification = guild.verificationLevel;

  for (const [, ch] of guild.channels.cache) {
    try {
      const ow = ch.permissionOverwrites?.cache?.get(everyone.id);
      if (ow) {
        savedOverwrites.set(ch.id, {
          send: ow.allow.has(PermissionFlagsBits.SendMessages)
            ? true
            : ow.deny.has(PermissionFlagsBits.SendMessages) ? false : null,
          connect: ow.allow.has(PermissionFlagsBits.Connect)
            ? true
            : ow.deny.has(PermissionFlagsBits.Connect) ? false : null,
        });
      } else {
        savedOverwrites.set(ch.id, null);
      }
      if (ch.isTextBased() || ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) {
        await ch.permissionOverwrites.edit(everyone, { SendMessages: false, Connect: false });
      }
    } catch (e) {
      console.error(`lockdown skip #${ch.name}:`, e.message);
    }
  }

  try {
    if (guild.verificationLevel < GuildVerificationLevel.High) {
      await guild.setVerificationLevel(GuildVerificationLevel.High, 'Raid lockdown');
    }
  } catch (e) {
    console.error('verification level:', e.message);
  }

  isLocked = true;
  await log(guild, `🚨 **LOCKDOWN by ${reason}**\nDenied Send Messages / Connect for @everyone. Verification set to High. Run \`/unlockserver\` to restore.`);
}

async function doUnlockServer(guild, runBy) {
  const everyone = guild.roles.everyone;

  for (const [channelId, prev] of savedOverwrites) {
    const ch = guild.channels.cache.get(channelId);
    if (!ch) continue;
    try {
      if (prev === null) {
        // there was no overwrite before -> just clear what we set
        await ch.permissionOverwrites.edit(everyone, { SendMessages: null, Connect: null });
      } else {
        await ch.permissionOverwrites.edit(everyone, { SendMessages: prev.send, Connect: prev.connect });
      }
    } catch (e) {
      console.error(`unlock skip #${ch.name}:`, e.message);
    }
  }
  savedOverwrites = new Map();

  try {
    if (savedVerification !== null) {
      await guild.setVerificationLevel(savedVerification, 'Lockdown lifted');
      savedVerification = null;
    }
  } catch (e) {
    console.error('restore verification:', e.message);
  }

  isLocked = false;
  await log(guild, `✅ **Server unlocked by ${runBy}** — permissions restored.`);
}

// ---------- SLASH COMMANDS ----------
const commands = [
  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Unlock admin commands with the password')
    .addStringOption(o => o.setName('password').setDescription('Bot password').setRequired(true)),
  new SlashCommandBuilder()
    .setName('popular')
    .setDescription('Type a message, then click the button to send it 5 times')
    .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true)),
  new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Lock the server (deny Send Messages / Connect for @everyone)')
    .addStringOption(o => o.setName('reason').setDescription('Why?').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('unlockserver')
    .setDescription('Restore permissions after a lockdown')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('nuke-channels')
    .setDescription('Delete channels (needs unlock + type server name to confirm)')
    .addStringOption(o => o.setName('type').setDescription('Which channels?').setRequired(true)
      .addChoices(
        { name: 'text', value: 'text' },
        { name: 'voice', value: 'voice' },
        { name: 'all', value: 'all' },
      ))
    .addStringOption(o => o.setName('category').setDescription('Only channels in this category').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName('clear-messages')
    .setDescription('Bulk-delete recent messages (under 14 days only)')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to clean').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('How many (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder()
    .setName('reset-category')
    .setDescription('Delete every channel inside one category (keeps the category)')
    .addStringOption(o => o.setName('name').setDescription('Category name').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName('clone-layout')
    .setDescription('Save channel/category layout to layout.json')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('protect-status')
    .setDescription('Show raid-protection toggles + punishments')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('protect-toggle')
    .setDescription('Turn a filter on/off')
    .addStringOption(o => o.setName('module').setDescription('Which filter?').setRequired(true)
      .addChoices(
        { name: 'anti-spam', value: 'antiSpam' },
        { name: 'anti-link (disable links)', value: 'antiLink' },
        { name: 'anti-mention', value: 'antiMention' },
        { name: 'anti-raid (mass-join lockdown)', value: 'antiRaid' },
      ))
    .addStringOption(o => o.setName('state').setDescription('on or off').setRequired(true)
      .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('set-punishment')
    .setDescription('Set what happens for spam/link/mention')
    .addStringOption(o => o.setName('trigger').setDescription('Which?').setRequired(true)
      .addChoices(
        { name: 'spam', value: 'punishSpam' },
        { name: 'link', value: 'punishLink' },
        { name: 'mention', value: 'punishMention' },
      ))
    .addStringOption(o => o.setName('action').setDescription('Punishment').setRequired(true)
      .addChoices(
        { name: 'delete only', value: 'delete' },
        { name: 'timeout', value: 'timeout' },
        { name: 'kick', value: 'kick' },
        { name: 'ban', value: 'ban' },
      ))
    .addIntegerOption(o => o.setName('minutes').setDescription('Timeout length in minutes (for timeout)').setRequired(false).setMinValue(1).setMaxValue(40320))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('set-min-age')
    .setDescription('Flag accounts younger than X days on join (0 = off)')
    .addIntegerOption(o => o.setName('days').setDescription('Min account age in days (0-90)').setRequired(true).setMinValue(0).setMaxValue(90))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);

  await rest.put(route, { body: commands });
  console.log(GUILD_ID ? `Slash commands registered to guild ${GUILD_ID}` : 'Slash commands registered globally');
}

// ---------- EVENTS ----------
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('Command register failed:', e.status, e.code, e.message);
    console.error('Full error:', JSON.stringify(e, null, 2).slice(0, 2000));
  }
});

// A) ping phrase -> Enter Password button
client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild) return;

  // --- ping phrase (checked before spam so your own test msgs don't time you out) ---
  const mentioned = msg.mentions.users.has(client.user.id);
  if (mentioned && msg.content.toLowerCase().includes('i wanna use you please')) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('unlock_btn')
        .setLabel('Enter Password')
        .setStyle(ButtonStyle.Primary)
    );
    await msg.reply({ content: 'Click below to enter the password:', components: [row] });
    return;
  }

  // --- B) filters: anti-link / anti-spam / anti-mention (skip whitelisted) ---
  try {
    const member = msg.member;
    if (member && !isWhitelisted(member)) {
      // links
      if (protect.antiLink && hasLink(msg.content)) {
        const res = await doPunish(member, msg, protect.punishLink, 'Link blocked');
        await log(msg.guild, `🔗 Link by ${msg.author.tag} (<@${msg.author.id}>) in #${msg.channel.name} → ${res}\n> ${(msg.content || '').slice(0, 300)}`);
        return;
      }
      // mass mention (5+)
      if (protect.antiMention && msg.mentions.users.size >= 5) {
        const res = await doPunish(member, msg, protect.punishMention, 'Mass mention (5+)');
        await log(msg.guild, `⏱️ Mention-spam by ${msg.author.tag} (<@${msg.author.id}>) (${msg.mentions.users.size} mentions) → ${res}`);
        return;
      }
      // spam: 5+ msgs in 3s
      if (protect.antiSpam) {
        const now = Date.now();
        const arr = (msgTimes.get(msg.author.id) || []).filter(t => now - t < 3000);
        arr.push(now);
        msgTimes.set(msg.author.id, arr);
        if (arr.length >= 5) {
          const res = await doPunish(member, msg, protect.punishSpam, 'Spam: 5+ messages in 3s');
          await log(msg.guild, `⏱️ Spam by ${msg.author.tag} (<@${msg.author.id}>) (5+ msgs in 3s) → ${res}`);
          msgTimes.set(msg.author.id, []);
        }
      }
    }
  } catch (e) {
    console.error('filters:', e.message);
  }
});

// B) mass-join detection
client.on('guildMemberAdd', async (member) => {
  if (GUILD_ID && member.guild.id !== GUILD_ID) return;
  const now = Date.now();
  joinTimes.push(now);
  while (joinTimes.length && now - joinTimes[0] > 30_000) joinTimes.shift();

  const ageDays = (now - member.user.createdTimestamp) / 86400000;
  const young = protect.minAccountAgeDays > 0 && ageDays < protect.minAccountAgeDays;
  await log(member.guild, `➕ Join: ${member.user.tag} (account ${ageDays.toFixed(1)}d old${young ? ' ⚠️ YOUNG' : ''}, ${joinTimes.length} in last 30s)`);

  if (young) {
    try {
      const ch = await getModLog(member.guild);
      await ch.send(`${pingMe(member.guild)} ⚠️ Young account: ${member.user.tag} (<@${member.id}>) — ${ageDays.toFixed(1)}d old (min ${protect.minAccountAgeDays}d).`);
    } catch {}
  }

  if (protect.antiRaid && joinTimes.length > 5 && now - lastAutoLock > 60_000) {
    lastAutoLock = now;
    await doLockdown(member.guild, 'auto raid detection (6+ joins in 30s)');
    const ch = await getModLog(member.guild);
    await ch.send(`${pingMe(member.guild)} ⚠️ **Possible raid:** ${joinTimes.length} joins in 30s. Server locked.`);
  }
});

// ---------- INTERACTIONS ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // --- Button: open password modal ---
    if (interaction.isButton() && interaction.customId === 'unlock_btn') {
      const modal = new ModalBuilder().setCustomId('unlock_modal').setTitle('Enter password:');
      const input = new TextInputBuilder()
        .setCustomId('password')
        .setLabel('Enter password:')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (interaction.isButton() && interaction.customId.startsWith('popular:')) {
      const btnId = interaction.customId.replace(/^popular:/, '');
      const payload = popularMessages.get(btnId);
      if (!payload) {
        return interaction.reply({ content: '❌ That button expired. Run /popular again.', flags: MessageFlags.Ephemeral });
      }
      if (interaction.guildId !== payload.guildId || interaction.channelId !== payload.channelId) {
        return interaction.reply({ content: '❌ This button is only valid in the original channel.', flags: MessageFlags.Ephemeral });
      }
      const key = `${interaction.user.id}:${interaction.guild.id}`;
      const now = Date.now();
      const last = popularCooldowns.get(key) || 0;
      if (now - last < 1500) {
        const remaining = ((1500 - (now - last)) / 1000).toFixed(1);
        return interaction.reply({ content: `⏳ Please wait ${remaining}s before using /popular again.`, flags: MessageFlags.Ephemeral });
      }
      popularCooldowns.set(key, now);
      const channel = interaction.channel;
      if (!channel || !channel.isTextBased()) {
        return interaction.reply({ content: '❌ I can only send in a text channel.', flags: MessageFlags.Ephemeral });
      }
      for (let i = 0; i < 5; i++) {
        await channel.send(payload.text).catch(() => {});
      }
      return interaction.reply({ content: `✅ Sent "${payload.text}" 5 times.`, flags: MessageFlags.Ephemeral });
    }

    // --- Modal submits ---
    if (interaction.isModalSubmit()) {
      // password modal
      if (interaction.customId === 'unlock_modal') {
        const pw = interaction.fields.getTextInputValue('password');
        if (pw === BOT_PASSWORD) {
          authorized.add(interaction.user.id);
          return interaction.reply({ content: '✅ Unlocked!', flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: '❌ Wrong password.', flags: MessageFlags.Ephemeral });
      }

      // nuke confirm modal
      if (interaction.customId === 'nuke_confirm') {
        if (!(await requireMyGuild(interaction))) return;
        if (!isUnlocked(interaction.user.id)) {
          return interaction.reply({ content: '🔒 Unlock first.', flags: MessageFlags.Ephemeral });
        }
        const typed = interaction.fields.getTextInputValue('servername');
        const guild = interaction.guild;
        if (typed !== guild.name) {
          return interaction.reply({ content: `❌ Cancelled. You typed "${typed}" — must match exactly: "${guild.name}"`, flags: MessageFlags.Ephemeral });
        }
        const args = pendingNuke.get(interaction.user.id);
        pendingNuke.delete(interaction.user.id);
        if (!args) return interaction.reply({ content: '❌ Expired, run the command again.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await runNuke(guild, interaction, args.type, args.category);
        return;
      }

      // reset-category confirm modal
      if (interaction.customId === 'reset_confirm') {
        if (!(await requireMyGuild(interaction))) return;
        if (!isUnlocked(interaction.user.id)) {
          return interaction.reply({ content: '🔒 Unlock first.', flags: MessageFlags.Ephemeral });
        }
        const typed = interaction.fields.getTextInputValue('servername');
        const guild = interaction.guild;
        if (typed !== guild.name) {
          return interaction.reply({ content: `❌ Cancelled. You typed "${typed}" — must match exactly: "${guild.name}"`, flags: MessageFlags.Ephemeral });
        }
        const args = pendingReset.get(interaction.user.id);
        pendingReset.delete(interaction.user.id);
        if (!args) return interaction.reply({ content: '❌ Expired, run the command again.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await runResetCategory(guild, interaction, args.name);
        return;
      }
    }

    if (!interaction.isChatInputCommand()) return;

    // --- /unlock (no prior unlock needed, no guild lock needed) ---
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
        return interaction.reply({ content: '❌ Please enter a message.', flags: MessageFlags.Ephemeral });
      }
      const buttonId = `popular:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      popularMessages.set(buttonId, {
        text,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });
      setTimeout(() => popularMessages.delete(buttonId), 10 * 60 * 1000);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(buttonId)
          .setLabel('Send 5x')
          .setStyle(ButtonStyle.Primary)
      );

      return interaction.reply({
        content: `Click below to send this 5 times:\n> ${text}`,
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }

    // everything else: must be my guild + unlocked
    if (!(await requireMyGuild(interaction))) return;
    if (!(await requireUnlock(interaction))) return;
    const guild = interaction.guild;

    // --- /lockdown ---
    if (interaction.commandName === 'lockdown') {
      const reason = interaction.options.getString('reason') || `manual by ${interaction.user.tag}`;
      if (isLocked) return interaction.reply({ content: 'Already locked.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await doLockdown(guild, reason);
      await log(guild, `🔒 Manual lockdown by ${interaction.user.tag} (<@${interaction.user.id}>) — ${reason}`);
      return interaction.editReply('🔒 Server locked.');
    }

    // --- /unlockserver ---
    if (interaction.commandName === 'unlockserver') {
      if (!isLocked && savedOverwrites.size === 0) {
        return interaction.reply({ content: 'Server is not locked.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await doUnlockServer(guild, `${interaction.user.tag} (<@${interaction.user.id}>)`);
      return interaction.editReply('✅ Server unlocked, permissions restored.');
    }

    // --- /nuke-channels -> ask typed confirmation modal ---
    if (interaction.commandName === 'nuke-channels') {
      const type = interaction.options.getString('type', true);
      const category = interaction.options.getString('category') || null;
      pendingNuke.set(interaction.user.id, { type, category });
      const modal = new ModalBuilder().setCustomId('nuke_confirm').setTitle('Confirm deletion');
      const input = new TextInputBuilder()
        .setCustomId('servername')
        .setLabel(`Type server name to confirm: ${guild.name}`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(guild.name);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // --- /reset-category -> ask typed confirmation modal ---
    if (interaction.commandName === 'reset-category') {
      const name = interaction.options.getString('name', true);
      pendingReset.set(interaction.user.id, { name });
      const modal = new ModalBuilder().setCustomId('reset_confirm').setTitle('Confirm deletion');
      const input = new TextInputBuilder()
        .setCustomId('servername')
        .setLabel(`Type server name to confirm: ${guild.name}`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(guild.name);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // --- /clear-messages ---
    if (interaction.commandName === 'clear-messages') {
      const channel = interaction.options.getChannel('channel', true);
      const amount = interaction.options.getInteger('amount', true);
      if (channel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: '❌ Pick a text channel.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const deleted = await channel.bulkDelete(amount, true);
        await log(guild, `🧹 **Clear by ${interaction.user.tag} (<@${interaction.user.id}>)** in #${channel.name}: deleted ${deleted.size}/${amount} (older than 14 days can't be bulk-deleted).`);
        return interaction.editReply(
          deleted.size < amount
            ? `Deleted ${deleted.size}/${amount}. Note: messages older than 14 days can't be bulk-deleted.`
            : `Deleted ${deleted.size} messages in #${channel.name}.`
        );
      } catch (e) {
        return interaction.editReply(`❌ Failed: ${e.message}`);
      }
    }

    // --- /clone-layout ---
    if (interaction.commandName === 'clone-layout') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const data = [...guild.channels.cache.values()]
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map(c => ({
          id: c.id,
          name: c.name,
          type: ChannelType[c.type] ?? c.type,
          position: c.position ?? 0,
          parent: c.parent ? c.parent.name : null,
          topic: c.topic ?? null,
        }));
      fs.writeFileSync('layout.json', JSON.stringify({ guild: guild.name, savedAt: new Date().toISOString(), channels: data }, null, 2));
      await log(guild, `💾 Layout saved by ${interaction.user.tag} — ${data.length} channels -> layout.json`);
      return interaction.editReply(`Saved ${data.length} channels to layout.json`);
    }

    // --- /protect-status ---
    if (interaction.commandName === 'protect-status') {
      const on = v => (v ? 'ON ✅' : 'OFF ❌');
      return interaction.reply({
        content:
          `🛡️ **Protection status** (locked: ${isLocked ? 'YES' : 'no'}, DRY_RUN: ${DRY_RUN})\n` +
          `anti-spam: ${on(protect.antiSpam)} → ${protect.punishSpam}\n` +
          `anti-link: ${on(protect.antiLink)} → ${protect.punishLink}\n` +
          `anti-mention (5+): ${on(protect.antiMention)} → ${protect.punishMention}\n` +
          `anti-raid (6+ joins/30s → lockdown): ${on(protect.antiRaid)}\n` +
          `timeout length: ${protect.timeoutMinutes}m | min account age: ${protect.minAccountAgeDays}d (0=off)`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // --- /protect-toggle ---
    if (interaction.commandName === 'protect-toggle') {
      const mod = interaction.options.getString('module', true);
      const state = interaction.options.getString('state', true);
      protect[mod] = state === 'on';
      saveProtect();
      await log(guild, `⚙️ **Protect-toggle by ${interaction.user.tag}**: ${mod} → ${state.toUpperCase()}`);
      return interaction.reply({ content: `✅ ${mod} is now ${state.toUpperCase()}`, flags: MessageFlags.Ephemeral });
    }

    // --- /set-punishment ---
    if (interaction.commandName === 'set-punishment') {
      const trigger = interaction.options.getString('trigger', true);
      const action = interaction.options.getString('action', true);
      const minutes = interaction.options.getInteger('minutes');
      protect[trigger] = action;
      if (minutes) protect.timeoutMinutes = minutes;
      saveProtect();
      await log(guild, `⚙️ **Punishment by ${interaction.user.tag}**: ${trigger} → ${action}${minutes ? ` (${minutes}m)` : ''}`);
      return interaction.reply({ content: `✅ ${trigger} → ${action}${minutes ? `, timeout ${minutes}m` : ''}`, flags: MessageFlags.Ephemeral });
    }

    // --- /set-min-age ---
    if (interaction.commandName === 'set-min-age') {
      const days = interaction.options.getInteger('days', true);
      protect.minAccountAgeDays = days;
      saveProtect();
      await log(guild, `⚙️ **Min-age by ${interaction.user.tag}**: ${days}d (0=off)`);
      return interaction.reply({ content: days === 0 ? '✅ Young-account flag OFF' : `✅ Will flag accounts younger than ${days}d`, flags: MessageFlags.Ephemeral });
    }
  } catch (e) {
    console.error('interaction:', e);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `❌ Error: ${e.message}`, flags: MessageFlags.Ephemeral });
      } else if (interaction.isRepliable() && interaction.deferred) {
        await interaction.editReply(`❌ Error: ${e.message}`);
      }
    } catch {}
  }
});

// ---------- NUKE / RESET IMPLEMENTATION ----------
function matchType(channel, type) {
  const t = channel.type;
  const isText = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(t);
  const isVoice = [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(t);
  if (type === 'text') return isText;
  if (type === 'voice') return isVoice;
  return isText || isVoice; // 'all' = every channel except categories
}

async function runNuke(guild, interaction, type, categoryName) {
  let targets = [...guild.channels.cache.values()].filter(
    c => c.type !== ChannelType.GuildCategory && matchType(c, type)
  );
  if (categoryName) {
    targets = targets.filter(c => c.parent && c.parent.name.toLowerCase() === categoryName.toLowerCase());
  }
  if (!targets.length) {
    return interaction.editReply('Nothing matched.');
  }

  const list = targets.map(c => `#${c.name} (${ChannelType[c.type] ?? c.type})`).join('\n');

  if (DRY_RUN) {
    await log(guild, `🔍 **DRY-RUN nuke by ${interaction.user.tag}** (type=${type}${categoryName ? `, category=${categoryName}` : ''}) — would delete:\n${list}`);
    return interaction.editReply(`**DRY-RUN is ON** — would delete ${targets.length}:\n${list}\n\nSet DRY_RUN=false in .env + restart to actually delete.`);
  }

  let count = 0;
  for (const c of targets) {
    try {
      await c.delete(`Nuke by ${interaction.user.tag}`);
      count++;
    } catch (e) {
      console.error(`delete #${c.name}:`, e.message);
    }
  }
  await log(guild, `💥 **Nuke by ${interaction.user.tag} (<@${interaction.user.id}>)** type=${type}${categoryName ? ` category=${categoryName}` : ''} — deleted ${count}/${targets.length}:\n${list}`);
  return interaction.editReply(`Deleted ${count}/${targets.length} channels.`);
}

async function runResetCategory(guild, interaction, name) {
  const cat = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase()
  );
  if (!cat) return interaction.editReply(`❌ No category named "${name}".`);
  const children = [...guild.channels.cache.values()].filter(c => c.parentId === cat.id);
  if (!children.length) return interaction.editReply(`Category "${cat.name}" is already empty.`);

  const list = children.map(c => `#${c.name}`).join('\n');

  if (DRY_RUN) {
    await log(guild, `🔍 **DRY-RUN reset-category by ${interaction.user.tag}** (${cat.name}) — would delete:\n${list}`);
    return interaction.editReply(`**DRY-RUN is ON** — would delete ${children.length} in "${cat.name}":\n${list}\n\nSet DRY_RUN=false + restart to actually delete.`);
  }

  let count = 0;
  for (const c of children) {
    try {
      await c.delete(`Reset-category by ${interaction.user.tag}`);
      count++;
    } catch (e) {
      console.error(`delete #${c.name}:`, e.message);
    }
  }
  await log(guild, `💥 **Reset-category by ${interaction.user.tag} (<@${interaction.user.id}>)** "${cat.name}" — deleted ${count}/${children.length} (kept category):\n${list}`);
  return interaction.editReply(`Deleted ${count}/${children.length} in "${cat.name}" (category kept).`);
}

client.login(TOKEN);
