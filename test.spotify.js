
const spotifyUrlInfo = require("spotify-url-info");

async function main() {
  const url =
    "https://open.spotify.com/playlist/0hmfuqIDg6kJvfeeSha2ZC";

  try {
    const getTracks = await spotifyUrlInfo.getTracks(url);
    const tracks = await getTracks();

    console.log("Tracks returned:", tracks.length);

    for (const track of tracks.slice(0, 5)) {
      console.log(
        `${track.name || track.title || "Unknown title"} — ${
          (track.artists || []).map(a =>
            typeof a === "string" ? a : a.name
          ).join(", ") || "Unknown artist"
        }`
      );
    }
  } catch (error) {
    console.error("Spotify test failed:", error.message);
    process.exitCode = 1;
  }
}

main();
