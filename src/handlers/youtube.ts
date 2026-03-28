export async function handleYoutube(url: string): Promise<string> {
  const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
  if (!isYoutube) {
    throw new Error(`Not a YouTube URL: ${url}`);
  }
  // TODO: implement via youtube-dl-exec + yt-dlp binary
  return `YouTube processing not implemented yet — requires yt-dlp binary. URL: ${url}`;
}
