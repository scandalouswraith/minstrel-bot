
const spotifyUrlInfo = require("spotify-url-info");
const fetch = require("isomorphic-unfetch");

async function main() {
  const url =
    "https://open.spotify.com/playlist/0hmfuqIDg6kJvfeeSha2ZC";

  try {
    const { getTracks } = spotifyUrlInfo(fetch);
    const tracks = await getTracks(url);

    console.log("Tracks returned:", tracks.length);

    for (const track of tracks.slice(0, 5)) {
      const artists = Array.isArray(track.artists)
        ? track.artists
            .map((artist) =>
              typeof artist === "string" ? artist : artist.name
            )
            .filter(Boolean)
            .join(", ")
        : track.artist || "Unknown artist";

      console.log(
        `${track.name || track.title || "Unknown title"} — ${artists}`
      );
    }
  } catch (error) {
    console.error("Spotify test failed:", error.message);
    process.exitCode = 1;
  }
}

main();
