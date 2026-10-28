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
const spotifyUrlInfo = require("spotify-url-info");
const fetch = require("isomorphic-unfetch");

async function getSpotifyPlaylistTracks(url) {
  const { getTracks } = spotifyUrlInfo(fetch);
  const tracks = await getTracks(url);

  return tracks.map(track => {
    const artists = Array.isArray(track.artists)
      ? track.artists
          .map(artist =>
            typeof artist === "string" ? artist : artist.name
          )
          .filter(Boolean)
          .join(", ")
      : track.artist || "";

    return {
      title: track.name || track.title || "",
      artist: artists,
    };
  }).filter(track => track.title);
}

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
    username: "Hearthside Tavern",
  },

  playerOptions: {
    defaultSearchPlatform: "ytsearch",
    onDisconnect: {
      autoReconnect: false,
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

  // Prevent simultaneous events from creating duplicate messages.
  if (state.updatingLyrics) {
    state.pendingLyricsUpdate = true;
    return;
  }

  state.updatingLyrics = true;

  try {
    do {
      state.pendingLyricsUpdate = false;

      const index = Math.max(
        0,
        Math.min(state.index, state.lines.length - 1)
      );

      const embed = new EmbedBuilder()
        .setColor(0xB49A57)
        .setTitle(`🎵 ${state.title || "Now Playing"}`)
        .setDescription(lyricText(state.lines, index))
        .setFooter({ text: "Hearthside Tavern • Minstrel" });

      if (state.messageId) {
        try {
          const message = await channel.messages.fetch(state.messageId);
          await message.edit({ embeds: [embed] });
        } catch (error) {
          if (error.code !== 10008) throw error;

          // The old message was deleted; create a replacement.
          state.messageId = null;
        }
      }

      if (!state.messageId) {
        const message = await channel.send({ embeds: [embed] });
        state.messageId = message.id;
      }
    } while (state.pendingLyricsUpdate);
  } catch (error) {
    console.error("Lyrics display error:", error.message);
  } finally {
    state.updatingLyrics = false;
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
      .setFooter({ text: "Hearthside Tavern Minstrel" });

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
  
  console.log("[LyricsFound diagnostic]", {
  track: track?.info?.title,
  payloadKeys: payload && typeof payload === "object"
    ? Object.keys(payload)
    : [],
  lyricsKeys: lyrics && typeof lyrics === "object"
    ? Object.keys(lyrics)
    : [],
  hasLinesArray: Array.isArray(lyrics?.lines),
  lineCount: Array.isArray(lyrics?.lines)
    ? lyrics.lines.length
    : 0,
});
  
  const lines = Array.isArray(lyrics?.lines)
    ? lyrics.lines.filter(item => item && typeof item.line === "string")
    : [];

  if (!lines.length) return;

  const state = lyricsDisplays.get(player.guildId) || {
    messageId: null,
    lines: [],
    index: 0,
    title: track?.info?.title || "Now Playing",
  };

  // Ignore duplicate LyricsFound events for the same track.
  if (state.lines.length && state.title === (track?.info?.title || state.title)) {
    return;
  }

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
          volume: 30,
        });
      } else if (player.voiceChannelId !== voiceChannel.id) {
        return interaction.editReply(
          "I'm already playing in another voice channel. Use `/stop` there first."
        );
      }

      await player.connect();
      await player.setVolume(25);

const query = interaction.options.getString("query", true);
const isSpotifyPlaylist =
  /open\.spotify\.com\/playlist\//i.test(query);

if (isSpotifyPlaylist) {
  let playlistTracks;

  try {
    playlistTracks = await getSpotifyPlaylistTracks(query);
  } catch (error) {
    console.error("Spotify playlist retrieval failed:", error);
    return interaction.editReply(
      "I couldn't retrieve that Spotify playlist. Please check that the playlist is accessible."
    );
  }

  if (!playlistTracks.length) {
    return interaction.editReply(
      "I couldn't find any songs in that Spotify playlist."
    );
  }

  const matchedTracks = [];

  await interaction.editReply(
    `🎶 Found **${playlistTracks.length} songs**. Searching YouTube for matches now...`
  );


for (const song of playlistTracks) {
  try {
    let search = await player.search(
      {
        query: `${song.title} ${song.artist} official audio`,
        source: "youtube",
      },
      interaction.user
    );

    let match = search?.tracks?.[0];

    // Fall back to a normal search if no official-audio result appears.
    if (!match) {
      search = await player.search(
        {
          query: `${song.title} ${song.artist}`,
          source: "youtube",
        },
        interaction.user
      );

      match = search?.tracks?.[0];
    }

    if (match) {
      matchedTracks.push(match);
    } else {
      console.log(`Skipped unmatched song: ${song.title}`);
    }
  } catch (error) {
    console.error(`Could not match ${song.title}:`, error.message);
  }
}


  if (!matchedTracks.length) {
    return interaction.editReply(
      "I retrieved the playlist, but couldn't find playable YouTube matches."
    );
  }

// Automatically shuffle the matched playlist tracks.
for (let i = matchedTracks.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [matchedTracks[i], matchedTracks[j]] = [
    matchedTracks[j],
    matchedTracks[i],
  ];
}

await player.queue.add(matchedTracks);

if (!player.playing && !player.paused) {
  await player.play();
}

return interaction.editReply(
  `🎶 Added **${matchedTracks.length} of ${playlistTracks.length} songs** to the queue in shuffled order!`
);

const result = await player.search(
  query.startsWith("scsearch:")
    ? {
        query: query.slice("scsearch:".length).trim(),
        source: "soundcloud",
      }
    : { query },
  interaction.user
);

const tracks = result?.tracks || [];

if (result?.loadType === "error") {
  console.error(
    "Lavalink search error:",
    JSON.stringify(result.exception ?? result, null, 2)
  );
}

if (!tracks.length) {
  return interaction.editReply(
    "I couldn't find any playable tracks for that request."
  );
}

await player.queue.add([tracks[0]]);

if (!player.playing && !player.paused) {
  await player.play();
}

return interaction.editReply(
  `🎶 Added **${tracks[0].info.title}** to the queue!`
  );
}

    const currentPlayer = client.lavalink.players.get(interaction.guildId);


if (commandName === "queue") {
  if (!currentPlayer) {
    return interaction.reply("The tavern is quiet—nothing is playing.");
  }

  const current = currentPlayer.queue.current;
  const upcoming = currentPlayer.queue.tracks.slice(0, 10);

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
  const current = currentPlayer?.queue.current;

  return interaction.reply(
    current
      ? `🎵 Now playing: **${current.info.title}**`
      : "Nothing is playing right now."
  );
}


    if (commandName === "lyrics") {
      if (!currentPlayer?.queue.current) {
        return interaction.reply("There's no song playing right now.");
      }

      const state = lyricsDisplays.get(interaction.guildId);

      if (state?.lines?.length) {
        await updateLyricsDisplay(currentPlayer, state);
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

    if (!currentPlayer) {
      return interaction.reply({
        content: "Nothing is playing right now.",
        ephemeral: true,
      });
    }

    if (commandName === "skip") {
      await currentPlayer.skip();
      return interaction.reply("⏭️ Skipping to the next song!");
    }

    if (commandName === "pause") {
      await currentPlayer.pause();
      return interaction.reply("⏸️ Music paused.");
    }

    if (commandName === "resume") {
      await currentPlayer.resume();
      return interaction.reply("▶️ Music resumed!");
    }

    if (commandName === "stop") {
      await currentPlayer.unsubscribeLyrics().catch(() => {});
      await currentPlayer.stopPlaying(true);
      await currentPlayer.destroy();
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
