/** A post from GET /2/users/:id/mentions. `referenced_posts` is accepted beside `referenced_tweets`. */

export interface XUrlEntity {
  url?: string;
  expanded_url?: string;
  unwound_url?: string;
}

export interface XPost {
  id: string;
  text?: string;
  author_id?: string;
  conversation_id?: string;
  lang?: string;
  entities?: { urls?: XUrlEntity[] };
  note_tweet?: { text?: string; entities?: { urls?: XUrlEntity[] } };
  referenced_tweets?: { type: string; id: string }[];
  referenced_posts?: { type: string; id: string }[];
}

export interface MentionPage {
  data?: XPost[];
  includes?: { tweets?: XPost[]; posts?: XPost[] };
}

const SKIP_HOST =
  /^(?:www\.)?(?:x\.com|twitter\.com|mobile\.twitter\.com|t\.co|pic\.twitter\.com|pbs\.twimg\.com|video\.twimg\.com|hellenicdev\.eu)$/i;

export function postText(post: XPost): string {
  return `${post.text ?? ""}\n${post.note_tweet?.text ?? ""}`.trim();
}

export function mentionsHandle(post: XPost, handle: string): boolean {
  const name = handle.replace(/^@/, "").trim();
  if (!name) return false;
  return new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(postText(post));
}

export function isRetweet(post: XPost): boolean {
  return references(post).some((item) => item.type === "retweeted");
}

export function isStop(post: XPost): boolean {
  return /\bstop\b/i.test(postText(post)) || postText(post).toLowerCase().includes("σταμάτα");
}

export function replyLanguage(post: XPost): "en" | "el" {
  if (post.lang === "el") return "el";
  const text = postText(post);
  const greek = text.match(/[\u0370-\u03FF]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return greek > latin ? "el" : "en";
}

export function indexIncludes(page: MentionPage): Map<string, XPost> {
  const map = new Map<string, XPost>();
  for (const post of [...(page.includes?.tweets ?? []), ...(page.includes?.posts ?? [])]) {
    if (post?.id) map.set(post.id, post);
  }
  return map;
}

/** First usable article link on the mention, then on the post it quotes or replies to. */
export function articleLink(post: XPost, included: Map<string, XPost>): string | null {
  const own = firstUsable(post.entities?.urls) ?? firstUsable(post.note_tweet?.entities?.urls);
  if (own) return own;
  for (const ref of references(post)) {
    if (ref.type !== "replied_to" && ref.type !== "quoted") continue;
    const parent = included.get(ref.id);
    if (!parent) continue;
    const found = firstUsable(parent.entities?.urls) ?? firstUsable(parent.note_tweet?.entities?.urls);
    if (found) return found;
  }
  return null;
}

function references(post: XPost): { type: string; id: string }[] {
  return post.referenced_tweets ?? post.referenced_posts ?? [];
}

function firstUsable(urls: XUrlEntity[] | undefined): string | null {
  for (const item of urls ?? []) {
    const found = usable(item.unwound_url) || usable(item.expanded_url) || usable(item.url);
    if (found) return found;
  }
  return null;
}

function usable(raw: string | undefined): string | null {
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      SKIP_HOST.test(host) ||
      host.endsWith(".x.com") ||
      host.endsWith(".twitter.com") ||
      host.endsWith(".twimg.com") ||
      host.endsWith(".hellenicdev.eu")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
