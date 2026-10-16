// Feed parsing for RSS 2.0 / 0.9x, RSS 1.0 (RDF), Atom and JSON Feed.
//
// This is a dependency-free port of the parts of `feed-rs` that the worker
// uses, preserving the same format detection, namespace handling, field
// mapping and content/author fallback rules.

import { attrValue, childAsText, childElements, childrenAsString, parseXml } from "./xml.js";

// ── Known namespaces (mirrors feed-rs `NS`) ──

const NS_ATOM_URI = "http://www.w3.org/2005/Atom";
const NS_RSS_URI = "http://purl.org/rss/1.0/";
const NS_CONTENT_URI = "http://purl.org/rss/1.0/modules/content/";
const NS_DC_URI = "http://purl.org/dc/elements/1.1/";
const NS_MEDIA_URI = "http://search.yahoo.com/mrss/";
const NS_ITUNES_URI = "http://www.itunes.com/dtds/podcast-1.0.dtd";

/** Error thrown when a feed cannot be parsed (parse failures skip the feed's items). */
export class FeedParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedParseError";
  }
}

// ── Byte decoding ──

/**
 * Decodes feed bytes to a string, honouring a BOM or the XML prolog
 * `encoding` declaration when present (feed-rs decodes via the XML prolog).
 */
function decodeFeedBytes(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }

  const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 256));
  const match = /^<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(head);
  if (match) {
    const label = match[1].toLowerCase();
    if (label !== "utf-8" && label !== "utf8") {
      try {
        return new TextDecoder(label).decode(bytes);
      } catch {
        // Unknown label: fall through to UTF-8.
      }
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

// ── Timestamp parsing (mirrors feed-rs `parse_timestamp_lenient`) ──

function tryParseRfc3339(original) {
  let cleaned = original
    .replace(/([+-])(\d{2})(\d{2})/, "$1$2:$3")
    .replace(/-\d{2}$/, "$&T00:00:00+00:00");
  const parsed = Date.parse(cleaned);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function tryParseRfc2822(original) {
  let cleaned = original
    .replace(/(UTC|-0000$)/, "+0000")
    .replace(/(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*, /, "")
    .replace(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*/, "$1")
    .replace(/ 24:/, " 00:")
    .replace(/ ([0-9]):/, " 0$1:");
  const parsed = Date.parse(cleaned);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function tryParseRfc1123(original) {
  const cleaned = original.replace(/ Z$/, " +0000").replace(/^[A-Za-z]{3}, /, "");
  const parsed = Date.parse(cleaned);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * Parses a feed timestamp leniently. Returns `null` when no format matches.
 *
 * @param {string|null|undefined} raw
 * @returns {Date|null}
 */
export function parseTimestamp(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }
  const original = String(raw).trim();
  return tryParseRfc3339(original) ?? tryParseRfc2822(original) ?? tryParseRfc1123(original);
}

// ── Namespace helpers ──

function classifyUri(uri) {
  switch (uri) {
    case NS_ATOM_URI:
      return "atom";
    case NS_RSS_URI:
      return "rss";
    case NS_CONTENT_URI:
      return "content";
    case NS_DC_URI:
      return "dc";
    case NS_MEDIA_URI:
      return "media";
    case NS_ITUNES_URI:
      return "itunes";
    default:
      return "unknown";
  }
}

/**
 * Returns `"{namespace}:{localName}"` for an element. Elements without a
 * resolved namespace URI fall back to the document's default namespace
 * (mirrors feed-rs' `set_default_default_namespace`).
 */
function tagOf(element, defaultNs) {
  const ns = element.uri === null ? defaultNs : classifyUri(element.uri);
  return `${ns}:${element.name}`;
}

// ── Model helpers ──

function newFeed() {
  return { authors: [], entries: [] };
}

function newEntry() {
  return {
    title: null,
    links: [],
    summary: null,
    content: null,
    authors: [],
    contributors: [],
    published: null,
    updated: null,
    media: [],
  };
}

function newMediaObject() {
  return { title: null, description: null, content: 0, thumbnails: 0, texts: 0 };
}

function mediaObjectHasContent(media) {
  return (
    media.title !== null ||
    media.description !== null ||
    media.content > 0 ||
    media.thumbnails > 0 ||
    media.texts > 0
  );
}

/** Pseudo MIME type check matching the `mediatype` crate's accepted shape. */
function isMimeType(value) {
  return /^[^\s/;]+\/[^\s/;]+/.test(value);
}

/** Checks an absolute URI the way `url::Url::parse` does for `media:*` URLs. */
function isAbsoluteUrl(value) {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// ── Text extraction helpers ──

/** RSS `util::handle_text` — no content-type validation. */
function rssText(element) {
  return { content: childrenAsString(element) };
}

/** RSS `handle_encoded` — HTML text; `null` when the body is empty. */
function rssEncoded(element) {
  const body = childrenAsString(element);
  if (body === "") {
    return null;
  }
  return { body };
}

/** Atom `handle_text` — rejects unknown content types. */
function atomText(element) {
  const type = attrValue(element, "type") ?? "text";
  if (type !== "text" && type !== "html" && type !== "xhtml" && type !== "text/html") {
    throw new FeedParseError(`unsupported content type ${type}`);
  }
  return { content: childrenAsString(element) };
}

/** MediaRSS `handle_text` — rejects unknown content types. */
function mediaText(element) {
  const type = attrValue(element, "type") ?? "plain";
  if (type !== "plain" && type !== "html") {
    throw new FeedParseError(`unsupported content type ${type}`);
  }
  return { content: childrenAsString(element) };
}

function handleTimestamp(element) {
  return parseTimestamp(childAsText(element));
}

function handlePerson(element) {
  const person = { name: "unknown", uri: null, email: null };
  for (const child of childElements(element)) {
    const text = childAsText(child);
    if (child.name === "name" && text !== null) {
      person.name = text;
    } else if (child.name === "uri") {
      person.uri = text;
    } else if (child.name === "email") {
      person.email = text;
    }
  }
  return person;
}

// ── MediaRSS handling ──

function handleMediaThumbnail(element, media) {
  if (attrValue(element, "url") !== undefined) {
    media.thumbnails += 1;
  }
}

function handleMediaContent(element, media, defaultNs) {
  const url = attrValue(element, "url");
  let hasUrl = url !== undefined && isAbsoluteUrl(url);

  for (const child of childElements(element)) {
    switch (tagOf(child, defaultNs)) {
      case "media:player": {
        const playerUrl = attrValue(child, "url");
        if (playerUrl !== undefined && isAbsoluteUrl(playerUrl)) {
          hasUrl = true;
        }
        break;
      }
      case "media:title":
        if (media.title === null) {
          media.title = mediaText(child).content;
        }
        break;
      case "media:description":
        if (media.description === null) {
          media.description = mediaText(child).content;
        }
        break;
      case "media:text":
        if (childAsText(child) !== null) {
          media.texts += 1;
        }
        break;
      case "media:credit":
        break;
      default:
        if (tagOf(child, defaultNs).startsWith("media:")) {
          handleMediaElement(child, media, defaultNs);
        }
        break;
    }
  }

  if (hasUrl) {
    media.content += 1;
  }
}

function handleMediaElement(element, media, defaultNs) {
  switch (tagOf(element, defaultNs)) {
    case "media:title":
      media.title = mediaText(element).content;
      break;
    case "media:content":
      handleMediaContent(element, media, defaultNs);
      break;
    case "media:thumbnail":
      handleMediaThumbnail(element, media);
      break;
    case "media:description":
      media.description = mediaText(element).content;
      break;
    case "media:text":
      if (childAsText(element) !== null) {
        media.texts += 1;
      }
      break;
    case "media:credit":
      // Credits are parsed by feed-rs but not used by this worker.
      break;
    case "media:community":
      break;
    case "media:rating":
      break;
    default:
      break;
  }
}

function handleMediaGroup(element, defaultNs) {
  const media = newMediaObject();
  for (const child of childElements(element)) {
    if (tagOf(child, defaultNs).startsWith("media:")) {
      handleMediaElement(child, media, defaultNs);
    }
  }
  return media;
}

/** iTunes item elements populate the entry's default media object. */
function handleItunesItemElement(element, media) {
  switch (element.name) {
    case "title":
      media.title = atomText(element).content;
      break;
    case "image":
      if (attrValue(element, "href") !== undefined) {
        media.thumbnails += 1;
      }
      break;
    case "summary":
      media.description = atomText(element).content;
      break;
    case "duration":
    case "author":
    default:
      break;
  }
}

// ── RSS 2.0 / 0.9x ──

function handleEnclosure(element, media) {
  const url = attrValue(element, "url");
  let hasUrl = false;
  if (url !== undefined) {
    hasUrl = isAbsoluteUrl(url);
  }
  if (hasUrl) {
    media.content += 1;
  }
}

function parseRss2Item(element, defaultNs) {
  const entry = newEntry();
  const media = newMediaObject();

  for (const child of childElements(element)) {
    const tag = tagOf(child, defaultNs);
    switch (tag) {
      case "rss:title":
        entry.title = rssText(child).content;
        break;
      case "rss:link": {
        const href = childAsText(child);
        if (href !== null) {
          entry.links.push({ href });
        }
        break;
      }
      case "rss:description":
        entry.summary = rssText(child);
        break;
      case "rss:author": {
        // feed-rs' `handle_contact("author", ..)` sets the person's name to the role.
        const email = childAsText(child);
        if (email !== null) {
          entry.authors.push({ name: "author", email });
        }
        break;
      }
      case "rss:pubDate":
      case "dc:date":
        entry.published = handleTimestamp(child);
        break;
      case "content:encoded":
        entry.content = rssEncoded(child);
        break;
      case "dc:creator": {
        entry.authors.push({ name: childrenAsString(child) });
        break;
      }
      case "rss:enclosure":
        handleEnclosure(child, media);
        break;
      case "media:group":
        entry.media.push(handleMediaGroup(child, defaultNs));
        break;
      default:
        if (tag.startsWith("itunes:")) {
          handleItunesItemElement(child, media);
        } else if (tag.startsWith("media:")) {
          handleMediaElement(child, media, defaultNs);
        }
        break;
    }
  }

  if (mediaObjectHasContent(media)) {
    entry.media.push(media);
  }
  if (entry.updated === null && entry.published !== null) {
    entry.updated = entry.published;
  }
  return entry;
}

function parseRss2(root, defaultNs) {
  const feed = newFeed();
  const channel = childElements(root).find((element) => element.name === "channel");
  if (channel === undefined) {
    throw new FeedParseError("no root element");
  }
  for (const child of childElements(channel)) {
    const tag = tagOf(child, defaultNs);
    if (tag === "itunes:author") {
      const name = childAsText(child);
      if (name !== null) {
        feed.authors.push({ name });
      }
    } else if (tag === "rss:item") {
      feed.entries.push(parseRss2Item(child, defaultNs));
    }
  }
  return feed;
}

// ── RSS 1.0 (RDF) ──

function parseRss1Item(element, defaultNs) {
  const entry = newEntry();
  let contentEncoded = null;

  for (const child of childElements(element)) {
    switch (tagOf(child, defaultNs)) {
      case "rss:title":
        entry.title = rssText(child).content;
        break;
      case "rss:link": {
        const href = childAsText(child);
        if (href !== null) {
          entry.links.push({ href });
        }
        break;
      }
      case "rss:description":
        entry.summary = rssText(child);
        break;
      case "content:encoded":
        contentEncoded = rssEncoded(child);
        break;
      case "dc:creator": {
        const name = childAsText(child);
        if (name !== null) {
          entry.authors.push({ name });
        }
        break;
      }
      case "dc:date":
        entry.published = handleTimestamp(child);
        break;
      case "dc:description":
        if (entry.summary === null) {
          entry.summary = rssText(child);
        }
        break;
      default:
        break;
    }
  }

  if (entry.content === null && contentEncoded !== null) {
    entry.content = contentEncoded;
  }
  // feed-rs drops RSS 1.0 items that have no link.
  if (entry.links.length === 0) {
    return null;
  }
  return entry;
}

function parseRss1(root, defaultNs) {
  const feed = newFeed();
  for (const child of childElements(root)) {
    const tag = tagOf(child, defaultNs);
    if (tag === "rss:channel") {
      for (const channelChild of childElements(child)) {
        if (tagOf(channelChild, defaultNs) === "dc:creator") {
          const name = childAsText(channelChild);
          if (name !== null) {
            feed.authors.push({ name });
          }
        }
      }
    } else if (tag === "rss:item") {
      const entry = parseRss1Item(child, defaultNs);
      if (entry !== null) {
        feed.entries.push(entry);
      }
    }
  }
  return feed;
}

// ── Atom ──

function handleAtomContent(element) {
  const type = attrValue(element, "type");
  const src = attrValue(element, "src");

  if (src !== undefined) {
    if (type !== undefined && !isMimeType(type)) {
      throw new FeedParseError(`unsupported content type ${type}`);
    }
    if (childAsText(element) !== null) {
      throw new FeedParseError("non-empty atom:content with src");
    }
    return { body: null };
  }

  if (type === undefined || type === "text" || type === "html" || type === "xhtml" || type === "text/html") {
    return { body: atomText(element).content };
  }

  if (type.endsWith("+xml") || type.endsWith("/xml")) {
    // feed-rs routes this through `handle_text`, which validates the type
    // attribute, so MIME types like application/xhtml+xml are rejected.
    return { body: atomText(element).content };
  }

  if (isMimeType(type)) {
    const body = childAsText(element);
    if (body === null) {
      throw new FeedParseError("missing content element content.inline");
    }
    return { body };
  }

  throw new FeedParseError(`unsupported content type ${type}`);
}

function handleAtomLink(element) {
  const href = attrValue(element, "href");
  if (href === undefined) {
    return null;
  }
  return { href };
}

function parseAtomEntry(element, defaultNs) {
  const entry = newEntry();
  const media = newMediaObject();

  for (const child of childElements(element)) {
    const tag = tagOf(child, defaultNs);
    switch (tag) {
      case "atom:title":
        entry.title = atomText(child).content;
        break;
      case "atom:updated": {
        const text = childAsText(child);
        if (text !== null) {
          entry.updated = parseTimestamp(text);
        }
        break;
      }
      case "atom:author":
        entry.authors.push(handlePerson(child));
        break;
      case "atom:content":
        entry.content = handleAtomContent(child);
        break;
      case "atom:link": {
        const link = handleAtomLink(child);
        if (link !== null) {
          entry.links.push(link);
        }
        break;
      }
      case "atom:summary":
        entry.summary = atomText(child);
        break;
      case "atom:contributor":
        entry.contributors.push(handlePerson(child));
        break;
      case "atom:published":
      case "atom:pubDate": {
        const text = childAsText(child);
        if (text !== null) {
          entry.published = parseTimestamp(text);
        }
        break;
      }
      case "media:group":
        entry.media.push(handleMediaGroup(child, defaultNs));
        break;
      default:
        if (tag.startsWith("media:")) {
          handleMediaElement(child, media, defaultNs);
        }
        break;
    }
  }

  if (media.content > 0 || media.thumbnails > 0) {
    entry.media.push(media);
  }
  return entry;
}

function parseAtomFeed(root, defaultNs) {
  const feed = newFeed();
  for (const child of childElements(root)) {
    switch (tagOf(child, defaultNs)) {
      case "atom:author":
        feed.authors.push(handlePerson(child));
        break;
      case "atom:contributor":
        handlePerson(child);
        break;
      case "atom:entry":
        feed.entries.push(parseAtomEntry(child, defaultNs));
        break;
      default:
        break;
    }
  }
  return feed;
}

// ── JSON Feed ──

function optString(value, field) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new FeedParseError(`invalid JSON feed field ${field}`);
  }
  return value;
}

function handleJsonAuthors(accumulated, author, authors, field) {
  const merge = (jsonAuthor) => {
    if (jsonAuthor === undefined || jsonAuthor === null) {
      return;
    }
    if (typeof jsonAuthor !== "object" || Array.isArray(jsonAuthor)) {
      throw new FeedParseError(`invalid JSON feed field ${field}`);
    }
    const name = optString(jsonAuthor.name, `${field}.name`);
    if (name === undefined) {
      return;
    }
    if (!accumulated.some((person) => person.name === name)) {
      accumulated.push({ name, uri: optString(jsonAuthor.url, `${field}.url`) ?? null });
    }
  };

  merge(author);
  if (authors !== undefined && authors !== null) {
    if (!Array.isArray(authors)) {
      throw new FeedParseError(`invalid JSON feed field ${field}`);
    }
    for (const jsonAuthor of authors) {
      merge(jsonAuthor);
    }
  }
}

function handleJsonContent(content) {
  if (content === undefined || content === null) {
    return null;
  }
  return { body: content.trim() };
}

function parseJsonFeed(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new FeedParseError(`unable to parse JSON: ${error.message}`);
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new FeedParseError("unable to parse JSON: expected an object");
  }
  if (typeof json.version !== "string") {
    throw new FeedParseError("unable to parse JSON: missing version");
  }
  if (typeof json.title !== "string") {
    throw new FeedParseError("unable to parse JSON: missing title");
  }
  if (!Array.isArray(json.items)) {
    throw new FeedParseError("unable to parse JSON: missing items");
  }
  if (!json.version.startsWith("https://jsonfeed.org/version/1")) {
    throw new FeedParseError(`unsupported version: ${json.version}`);
  }

  const feed = newFeed();
  handleJsonAuthors(feed.authors, json.author, json.authors, "author");

  for (const item of json.items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new FeedParseError("invalid JSON feed item");
    }

    const entry = newEntry();
    const url = optString(item.url, "item.url");
    const externalUrl = optString(item.external_url, "item.external_url");
    if (url !== undefined) {
      entry.links.push({ href: url });
    }
    if (externalUrl !== undefined) {
      entry.links.push({ href: externalUrl });
    }

    const title = optString(item.title, "item.title");
    if (title !== undefined) {
      entry.title = title;
    }

    entry.content = handleJsonContent(optString(item.content_html, "item.content_html"));
    const summary = optString(item.summary, "item.summary");
    if (summary !== undefined) {
      entry.summary = { content: summary };
    }

    const contentText = handleJsonContent(optString(item.content_text, "item.content_text"));
    if (contentText !== null) {
      if (entry.content === null) {
        entry.content = contentText;
      } else if (entry.summary === null) {
        entry.summary = { content: contentText.body };
      }
    }

    const published = optString(item.date_published, "item.date_published");
    if (published !== undefined) {
      entry.published = parseTimestamp(published);
    }
    const modified = optString(item.date_modified, "item.date_modified");
    if (modified !== undefined) {
      entry.updated = parseTimestamp(modified);
    }

    handleJsonAuthors(entry.authors, item.author, item.authors, "item.author");
    feed.entries.push(entry);
  }

  // Per the spec, any items without an author inherit the feed's authors.
  if (feed.authors.length > 0) {
    for (const entry of feed.entries) {
      if (entry.authors.length === 0) {
        entry.authors = feed.authors.map((person) => ({ ...person }));
      }
    }
  }

  return feed;
}

// ── Entry point ──

function parseXmlFeed(text) {
  const root = parseXml(text);

  let defaultNs;
  if (root.name === "feed" || root.name === "entry") {
    defaultNs = "atom";
  } else if (root.name === "rss" || root.name === "RDF") {
    defaultNs = "rss";
  } else {
    throw new FeedParseError("no root element");
  }

  if (root.name === "feed") {
    return parseAtomFeed(root, defaultNs);
  }
  if (root.name === "entry") {
    const feed = newFeed();
    feed.entries.push(parseAtomEntry(root, defaultNs));
    return feed;
  }
  if (root.name === "rss") {
    // feed-rs only accepts RSS with an explicit supported version attribute.
    const version = attrValue(root, "version");
    if (version !== "2.0" && version !== "0.91" && version !== "0.92") {
      throw new FeedParseError("no root element");
    }
    return parseRss2(root, defaultNs);
  }
  return parseRss1(root, defaultNs);
}

/**
 * Parses a feed document (RSS, Atom or JSON Feed) from raw bytes.
 *
 * @param {Uint8Array} bytes
 * @returns {{authors: Array<{name: string}>, entries: Array<object>}}
 */
export function parseFeed(bytes) {
  const text = decodeFeedBytes(bytes);
  const first = text.search(/[<{]/);
  if (first < 0) {
    throw new FeedParseError("no root element");
  }
  if (text[first] === "{") {
    return parseJsonFeed(text);
  }
  return parseXmlFeed(text);
}
