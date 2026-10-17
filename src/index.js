require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");

const { LavalinkManager } = require("lavalink-client");

const requiredEnv = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_GUILD_ID",
  "LAVALINK_HOST",
  "LAVALINK_PASSWORD",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song or Spotify playlist")
    .addStringOption(option =>
      option
        .setName("query")
        .setDescription("Song name, YouTube URL, or Spotify playlist URL")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current song"),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause playback"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume playback"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop music and clear the queue"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the upcoming songs"),

  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show the current song"),

  new SlashCommandBuilder()
    .setName("lyrics")
    .setDescription("Show synced lyrics for the current song"),
].map(command => command.toJSON());

const rest = new REST({ version: "10" })
  .setToken(process.env.DISCORD_TOKEN);

// One rolling lyrics message per server.
const lyricsDisplays = new Map();

client.lavalink = new LavalinkManager({
  nodes: [
    {
      id: "railway-lavalink",
      host: process.env.LAVALINK_HOST,
      port: Number(process.env.LAVALINK_PORT || 2333),
      authorization: process.env.LAVALINK_PASSWORD,
      secure: process.env.LAVALINK_SECURE === "true",
    },
  ],

  sendToShard: (guildId, payload) => {
    const guild = client.guilds.cache.get(guildId);
    guild?.shard?.send(payload);
  },

  client: {
    id: process.env.DISCORD_CLIENT_ID,
    username: "Whiskers & Ale Minstrel",
  },

  playerOptions: {
    defaultSearchPlatform: "ytsearch",
    onDisconnect: {
      autoReconnect: true,
      destroyPlayer: false,
    },
    onEmptyQueue: {
      destroyAfterMs: 30000,
    },
  },

  queueOptions: {
    maxPreviousTracks: 25,
  },
});

// Forward Discord voice-state updates to Lavalink.
client.on("raw", packet => {
  client.lavalink.sendRawData(packet);
});

client.once("ready", async () => {
  console.log(`🎶 ${client.user.tag} is online!`);

  try {
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID
      ),
      { body: commands }
    );

    console.log("Slash commands registered.");
    await client.lavalink.init(client.user);
    console.log("Lavalink manager initialized.");
  } catch (error) {
    console.error("Startup error:", error);
  }
});

function getLyricsChannel(player) {
  return client.channels.cache.get(player.textChannelId);
}

function lyricText(lines, index) {
  const previous = index > 0 ? lines[index - 1]?.line : "";
  const current = lines[index]?.line || "♪";
  const next = index + 1 < lines.length ? lines[index + 1]?.line : "";

  return [
    `*${previous || " " }*`,
    `**🎶 ${current} 🎶**`,
    `*${next || " "}*`,
  ].join("\n\n").slice(0, 4000);
}

async function updateLyricsDisplay(player, state) {
  const channel = getLyricsChannel(player);
  if (!channel || !state.lines.length) return;

  const index = Math.max(
    0,
    Math.min(state.index, state.lines.length - 1)
  );

  const embed = new EmbedBuilder()
    .setColor(0xB49A57)
    .setTitle(`🎵 ${state.title || "Now Playing"}`)
    .setDescription(lyricText(state.lines, index))
    .setFooter({ text: "Whiskers & Ale • Minstrel" });

  try {
    if (state.messageId) {
      const message = await channel.messages.fetch(state.messageId);
      await message.edit({ embeds: [embed] });
    } else {
      const message = await channel.send({ embeds: [embed] });
      state.messageId = message.id;
    }
  } catch (error) {
    // A deleted message can be recreated on the next lyrics event.
    if (error.code === 10008) state.messageId = null;
    else console.error("Lyrics display error:", error.message);
  }
}

client.lavalink.on("trackStart", async (player, track) => {
  const channel = getLyricsChannel(player);

  if (channel) {
    const embed = new EmbedBuilder()
      .setColor(0xB49A57)
      .setTitle("🍻 Now Playing")
      .setDescription(
        `**[${track.info.title}](${track.info.uri || "https://discord.com"})**`
      )
      .setFooter({ text: "Whiskers & Ale Minstrel" });

    await channel.send({ embeds: [embed] }).catch(console.error);
  }

  // Reset the rolling display for each new track.
  lyricsDisplays.set(player.guildId, {
    messageId: null,
    lines: [],
    index: 0,
    title: track.info.title,
  });

  try {
    await player.subscribeLyrics(false);
  } catch (error) {
    console.error("Could not subscribe to lyrics:", error.message);
  }
});

client.lavalink.on("LyricsFound", async (player, track, payload) => {
  const lyrics = payload?.lyrics || payload;
  const lines = Array.isArray(lyrics?.lines)
    ? lyrics.lines.filter(item => item && typeof item.line === "string")
    : [];

  if (!lines.length) return;

  const state = lyricsDisplays.get(player.guildId) || {
    messageId: null,
    index: 0,
    title: track?.info?.title || "Now Playing",
  };

  state.lines = lines;
  state.index = 0;
  state.title = track?.info?.title || state.title;
  lyricsDisplays.set(player.guildId, state);

  await updateLyricsDisplay(player, state);
});

client.lavalink.on("LyricsLine", async (player, track, payload) => {
  const state = lyricsDisplays.get(player.guildId);
  if (!state) return;

  // Keep the line list returned by LyricsFound and move the highlight.
  if (Number.isInteger(payload?.lineIndex)) {
    state.index = payload.lineIndex;
  } else if (payload?.line) {
    const found = state.lines.findIndex(
      item => item.timestamp === payload.line.timestamp &&
              item.line === payload.line.line
    );
    if (found >= 0) state.index = found;
  }

  await updateLyricsDisplay(player, state);
});

client.lavalink.on("LyricsNotFound", async player => {
  const channel = getLyricsChannel(player);
  if (!channel) return;

  const state = lyricsDisplays.get(player.guildId);
  if (state) state.lines = [];

  await channel.send(
    "🎵 I couldn't find synced lyrics for this track."
  ).catch(() => {});
});

client.lavalink.on("trackEnd", async player => {
  try {
    await player.unsubscribeLyrics();
  } catch {
    // The subscription may already have ended.
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    if (commandName === "play") {
      const voiceChannel = interaction.member.voice?.channel;

      if (!voiceChannel) {
        return interaction.reply({
          content: "Join a voice channel first, and I'll bring the music! 🍻",
          ephemeral: true,
        });
      }

      await interaction.deferReply();

      let player = client.lavalink.players.get(interaction.guildId);

      if (!player) {
        player = await client.lavalink.createPlayer({
          guildId: interaction.guildId,
          voiceChannelId: voiceChannel.id,
          textChannelId: interaction.channelId,
          selfDeaf: true,
          volume: 100,
        });
      } else if (player.voiceChannelId !== voiceChannel.id) {
        return interaction.editReply(
          "I'm already playing in another voice channel. Use `/stop` there first."
        );
      }

      await player.connect();

const query = interaction.options.getString("query", true);

const isSoundCloudSearch = query
  .toLowerCase()
  .startsWith("scsearch:");

const searchQuery = isSoundCloudSearch
  ? query.slice("scsearch:".length).trim()
  : query;

const result = await player.search(
  isSoundCloudSearch
    ? { query: searchQuery, source: "soundcloud" }
    : { query: searchQuery },
  interaction.user
);
      const tracks = result?.tracks || [];

      if (!tracks.length) {
        return interaction.editReply(
          "I couldn't find any playable tracks for that request."
        );
      }

      // Playlist URLs usually return multiple tracks; single searches use the first.
      const isPlaylist = Boolean(result.playlist);
      const selectedTracks = isPlaylist ? tracks : [tracks[0]];

      await player.queue.add(selectedTracks);

      if (!player.playing && !player.paused) {
        await player.play();
      }

      return interaction.editReply(
        isPlaylist
          ? `🎶 Added **${selectedTracks.length} tracks** from the playlist to the queue!`
          : `🎶 Added **${tracks[0].info.title}** to the queue!`
      );
    }

    const player = client.lavalink.players.get(interaction.guildId);

    if (commandName === "queue") {
      if (!player) {
        return interaction.reply("The tavern is quiet—nothing is playing.");
      }

      const current = player.queue.current;
      const upcoming = player.queue.tracks.slice(0, 10);

      const list = upcoming.map((track, index) =>
        `${index + 1}. ${track.info.title}`
      );

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xB49A57)
            .setTitle("🍺 Tavern Queue")
            .setDescription(
              `**Now:** ${current?.info?.title || "Nothing"}\n\n` +
              (list.join("\n") || "No upcoming tracks.")
            ),
        ],
      });
    }

    if (commandName === "nowplaying") {
      const current = player?.queue.current;

      return interaction.reply(
        current
          ? `🎵 Now playing: **${current.info.title}**`
          : "Nothing is playing right now."
      );
    }

    if (commandName === "lyrics") {
      if (!player?.queue.current) {
        return interaction.reply("There's no song playing right now.");
      }

      const state = lyricsDisplays.get(interaction.guildId);

      if (state?.lines?.length) {
        await updateLyricsDisplay(player, state);
        return interaction.reply({
          content: "I've refreshed the rolling lyrics display! 🎶",
          ephemeral: true,
        });
      }

      return interaction.reply({
        content: "I'm looking for synced lyrics. If none appear, this track may not have lyrics available.",
        ephemeral: true,
      });
    }

    if (!player) {
      return interaction.reply({
        content: "Nothing is playing right now.",
        ephemeral: true,
      });
    }

    if (commandName === "skip") {
      await player.skip();
      return interaction.reply("⏭️ Skipping to the next song!");
    }

    if (commandName === "pause") {
      await player.pause();
      return interaction.reply("⏸️ Music paused.");
    }

    if (commandName === "resume") {
      await player.resume();
      return interaction.reply("▶️ Music resumed!");
    }

    if (commandName === "stop") {
      await player.unsubscribeLyrics().catch(() => {});
      await player.stopPlaying(true);
      await player.destroy();
      lyricsDisplays.delete(interaction.guildId);
      return interaction.reply("🍻 Music stopped and the queue cleared.");
    }
  } catch (error) {
    console.error("Command error:", error);

    const message = "Something went wrong. Check the Minstrel's Railway logs for details.";

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: message,
        ephemeral: true,
      }).catch(() => {});
    } else {
      await interaction.reply({
        content: message,
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

client.lavalink.on("error", (node, error) => {
  console.error("Lavalink error:", error);
});

client.login(process.env.DISCORD_TOKEN);
