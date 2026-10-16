// Minimal, namespace-aware XML parser used by the feed parser.
//
// It intentionally mirrors the pieces of `quick-xml` + feed-rs' `xml` module
// that the feed mapping relies on:
//   * element names have their namespace prefix stripped (local name),
//   * elements carry the resolved namespace URI (or `null` when no namespace
//     is declared for them),
//   * attributes keep their qualified names and unescaped values,
//   * text, CDATA and entity references are coalesced into a single text node,
//   * comments and processing instructions are ignored,
//   * unknown named entities are retained in their escaped form.

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decodes XML character and entity references. Unknown named entities are
 * preserved verbatim, matching quick-xml's `GeneralRef` handling.
 *
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  if (!text.includes("&")) {
    return text;
  }
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9._:-]*);/g, (match, body) => {
    if (body[0] === "#") {
      let codePoint;
      if (body[1] === "x" || body[1] === "X") {
        codePoint = parseInt(body.slice(2), 16);
      } else {
        codePoint = parseInt(body.slice(1), 10);
      }
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return match;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const resolved = NAMED_ENTITIES[body];
    return resolved !== undefined ? resolved : match;
  });
}

class XmlParser {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    this.pos = 0;
  }

  error(message) {
    throw new Error(`xml: ${message} at position ${this.pos}`);
  }

  eof() {
    return this.pos >= this.text.length;
  }

  startsWith(prefix) {
    return this.text.startsWith(prefix, this.pos);
  }

  skipWhitespace() {
    while (!this.eof() && /\s/.test(this.text[this.pos])) {
      this.pos++;
    }
  }

  /** Skips up to and including `terminator`. */
  skipUntil(terminator) {
    const index = this.text.indexOf(terminator, this.pos);
    if (index < 0) {
      this.error(`unterminated ${terminator}`);
    }
    this.pos = index + terminator.length;
  }

  /** Skips a `<!DOCTYPE ...>` / `<!ENTITY ...>` declaration, honouring `[...]`. */
  skipDeclaration() {
    let depth = 0;
    while (!this.eof()) {
      const ch = this.text[this.pos];
      if (ch === "[") {
        depth++;
      } else if (ch === "]") {
        depth--;
      } else if (ch === ">" && depth <= 0) {
        this.pos++;
        return;
      }
      this.pos++;
    }
    this.error("unterminated declaration");
  }

  /** Parses the whole document and returns the root element. */
  parseDocument() {
    const context = { defaultUri: null, prefixes: Object.create(null) };
    let root = null;
    while (!this.eof()) {
      if (this.startsWith("<?")) {
        this.skipUntil("?>");
      } else if (this.startsWith("<!--")) {
        this.skipUntil("-->");
      } else if (this.startsWith("<!")) {
        this.skipDeclaration();
      } else if (this.startsWith("<")) {
        const element = this.parseElement(context);
        if (root === null) {
          root = element;
        } else {
          this.error("multiple root elements");
        }
      } else if (/\s/.test(this.text[this.pos])) {
        this.pos++;
      } else {
        this.error("unexpected text before root element");
      }
    }
    if (root === null) {
      this.error("no root element");
    }
    return root;
  }

  /**
   * Parses an element (and its subtree) starting at the current `<`.
   * @param {{defaultUri: string|null, prefixes: Record<string,string>}} parentContext
   */
  parseElement(parentContext) {
    this.pos++; // consume '<'

    const nameStart = this.pos;
    while (!this.eof() && !/[\s/>]/.test(this.text[this.pos])) {
      this.pos++;
    }
    const rawName = this.text.slice(nameStart, this.pos);
    if (rawName === "") {
      this.error("empty tag name");
    }

    const attributes = [];
    let selfClosing = false;

    for (;;) {
      this.skipWhitespace();
      if (this.eof()) {
        this.error(`unterminated start tag <${rawName}>`);
      }
      const ch = this.text[this.pos];
      if (ch === ">") {
        this.pos++;
        break;
      }
      if (ch === "/") {
        if (this.text[this.pos + 1] !== ">") {
          this.error("malformed self-closing tag");
        }
        this.pos += 2;
        selfClosing = true;
        break;
      }

      const attrStart = this.pos;
      while (!this.eof() && !/[\s=/>]/.test(this.text[this.pos])) {
        this.pos++;
      }
      const attrName = this.text.slice(attrStart, this.pos);
      if (attrName === "") {
        this.error("malformed attribute");
      }
      this.skipWhitespace();
      if (this.text[this.pos] !== "=") {
        this.error(`attribute ${attrName} without value`);
      }
      this.pos++;
      this.skipWhitespace();
      const quote = this.text[this.pos];
      if (quote !== '"' && quote !== "'") {
        this.error(`unquoted attribute ${attrName}`);
      }
      this.pos++;
      const valueStart = this.pos;
      while (!this.eof() && this.text[this.pos] !== quote) {
        this.pos++;
      }
      if (this.eof()) {
        this.error(`unterminated attribute ${attrName}`);
      }
      const rawValue = this.text.slice(valueStart, this.pos);
      this.pos++; // closing quote
      attributes.push({ name: attrName, value: decodeEntities(rawValue) });
    }

    // Build the namespace context for this element and its descendants.
    const context = {
      defaultUri: parentContext.defaultUri,
      prefixes: Object.assign(Object.create(null), parentContext.prefixes),
    };
    for (const attribute of attributes) {
      if (attribute.name === "xmlns") {
        context.defaultUri = attribute.value;
      } else if (attribute.name.startsWith("xmlns:")) {
        context.prefixes[attribute.name.slice(6)] = attribute.value;
      }
    }

    const colonIndex = rawName.lastIndexOf(":");
    const prefix = colonIndex >= 0 ? rawName.slice(0, colonIndex) : null;
    const localName = colonIndex >= 0 ? rawName.slice(colonIndex + 1) : rawName;
    const uri = prefix !== null ? context.prefixes[prefix] ?? null : context.defaultUri;

    const element = {
      name: localName,
      rawName,
      uri,
      attributes,
      children: [],
    };

    if (selfClosing) {
      return element;
    }

    let pendingText = "";
    const flushText = () => {
      if (pendingText !== "") {
        element.children.push(pendingText);
        pendingText = "";
      }
    };

    for (;;) {
      if (this.eof()) {
        this.error(`unclosed element <${rawName}>`);
      }
      if (this.text[this.pos] !== "<") {
        const nextTag = this.text.indexOf("<", this.pos);
        const end = nextTag < 0 ? this.text.length : nextTag;
        pendingText += decodeEntities(this.text.slice(this.pos, end));
        this.pos = end;
        continue;
      }
      if (this.startsWith("</")) {
        this.pos += 2;
        const endNameStart = this.pos;
        while (!this.eof() && this.text[this.pos] !== ">") {
          this.pos++;
        }
        const endName = this.text.slice(endNameStart, this.pos).trim();
        this.pos++;
        const endLocalName = endName.includes(":")
          ? endName.slice(endName.lastIndexOf(":") + 1)
          : endName;
        if (endLocalName !== localName) {
          this.error(`mismatched closing tag </${endName}> for <${rawName}>`);
        }
        flushText();
        return element;
      }
      if (this.startsWith("<!--")) {
        this.skipUntil("-->");
        continue;
      }
      if (this.startsWith("<![CDATA[")) {
        this.pos += 9; // consume '<![CDATA['
        const end = this.text.indexOf("]]>", this.pos);
        if (end < 0) {
          this.error("unterminated CDATA section");
        }
        pendingText += this.text.slice(this.pos, end);
        this.pos = end + 3;
        continue;
      }
      if (this.startsWith("<?")) {
        this.skipUntil("?>");
        continue;
      }
      if (this.startsWith("<!")) {
        this.skipDeclaration();
        continue;
      }

      flushText();
      element.children.push(this.parseElement(context));
    }
  }
}

/**
 * Parses an XML document into an element tree.
 *
 * @param {string} text
 * @returns {{name: string, rawName: string, uri: string|null, attributes: Array<{name: string, value: string}>, children: Array<object|string>}}
 */
export function parseXml(text) {
  return new XmlParser(text).parseDocument();
}

/**
 * Returns the value of the first attribute with the given qualified name.
 *
 * @param {object} element
 * @param {string} name
 * @returns {string|undefined}
 */
export function attrValue(element, name) {
  for (const attribute of element.attributes) {
    if (attribute.name === name) {
      return attribute.value;
    }
  }
  return undefined;
}

/** Returns the element children (skipping text nodes). */
export function childElements(element) {
  return element.children.filter((child) => typeof child !== "string");
}

/**
 * Returns the first child if it is a text node (feed-rs `child_as_text`).
 *
 * @param {object} element
 * @returns {string|null}
 */
export function childAsText(element) {
  if (element.children.length > 0 && typeof element.children[0] === "string") {
    return element.children[0];
  }
  return null;
}

function serializeElement(element) {
  let out = `<${element.name}`;
  for (const attribute of element.attributes) {
    out += ` ${attribute.name}="${attribute.value}"`;
  }
  out += ">";
  out += childrenAsString(element);
  out += `</${element.name}>`;
  return out;
}

/**
 * Concatenates the children of a node into a string, re-serialising nested
 * elements (feed-rs `children_as_string`).
 *
 * @param {object} element
 * @returns {string}
 */
export function childrenAsString(element) {
  let out = "";
  for (const child of element.children) {
    out += typeof child === "string" ? child : serializeElement(child);
  }
  return out;
}
