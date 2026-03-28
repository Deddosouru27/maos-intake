// Stub — replaced in task 3 with real vxtwitter + Threads implementation

export interface ThreadResult {
  text: string;
  author: string;
  platform: 'twitter' | 'threads';
}

export async function fetchThread(url: string): Promise<ThreadResult> {
  const platform: 'twitter' | 'threads' = url.includes('threads.net') ? 'threads' : 'twitter';
  return { text: '', author: '', platform };
}
