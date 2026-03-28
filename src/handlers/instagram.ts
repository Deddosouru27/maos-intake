// TODO: Instagram handler — implement in next iteration
// Options: instaloader (Python), rapid-api, or yt-dlp (supports Reels)

export async function handleInstagram(url: string): Promise<string> {
  const isInstagram = url.includes('instagram.com');
  if (!isInstagram) {
    throw new Error(`Not an Instagram URL: ${url}`);
  }
  throw new Error('Instagram handler not implemented yet');
}
