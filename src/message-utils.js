import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { randomInt } from "node:crypto";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const ALPHANUMERIC = `${LETTERS}${DIGITS}`;

export function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

export function addressDomain(value) {
  const address = normalizeAddress(value);
  const index = address.lastIndexOf("@");
  return index >= 0 ? address.slice(index + 1) : "";
}

export function validateLocalPart(value) {
  const local = String(value || "").trim().toLowerCase();
  if (!local || local.length > 48) throw new Error("invalid_local_part");
  if (!/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/.test(local)) {
    throw new Error("invalid_local_part");
  }
  if (/\.\./.test(local)) throw new Error("invalid_local_part");
  return local;
}

export function randomLocalPart(length = 12) {
  const target = Math.max(2, Number(length) || 12);
  const chars = [LETTERS[randomInt(LETTERS.length)], DIGITS[randomInt(DIGITS.length)]];
  while (chars.length < target) chars.push(ALPHANUMERIC[randomInt(ALPHANUMERIC.length)]);
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [chars[index], chars[swap]] = [chars[swap], chars[index]];
  }
  return chars.join("");
}

export async function readHeaderBlock(filePath, limit = 256 * 1024) {
  const handle = await fsPromises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(limit, 64 * 1024));
    const chunks = [];
    let total = 0;
    while (total < limit) {
      const wanted = Math.min(buffer.length, limit - total);
      const { bytesRead } = await handle.read(buffer, 0, wanted, total);
      if (!bytesRead) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
      const joined = Buffer.concat(chunks);
      const crlf = joined.indexOf("\r\n\r\n");
      const lf = joined.indexOf("\n\n");
      const boundary = crlf >= 0 ? crlf + 4 : lf >= 0 ? lf + 2 : -1;
      if (boundary >= 0) return joined.subarray(0, boundary);
    }
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

export async function parseMessageMetadata(filePath) {
  const header = await readHeaderBlock(filePath);
  const parsed = await simpleParser(Buffer.concat([header, Buffer.from("\r\n")]));
  return {
    messageId: String(parsed.messageId || "").trim(),
    subject: String(parsed.subject || "").trim(),
    fromText: String(parsed.from?.text || "").trim(),
    date: parsed.date instanceof Date && !Number.isNaN(parsed.date.valueOf())
      ? parsed.date.toISOString()
      : "",
  };
}

export function sanitizeEmailHtml(value) {
  return sanitizeHtml(String(value || ""), {
    allowedTags: [
      "a", "abbr", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3",
      "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s", "small",
      "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
      "tr", "u", "ul",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["alt", "title", "width", "height"],
      "*": ["class", "style"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedStyles: {
      "*": {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgb/i, /^[a-z]+$/i],
        "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgb/i, /^[a-z]+$/i],
        "font-size": [/^\d+(?:\.\d+)?(?:px|em|rem|%)$/],
        "font-weight": [/^(?:normal|bold|[1-9]00)$/],
        "font-style": [/^(?:normal|italic)$/],
        "text-align": [/^(?:left|right|center|justify)$/],
        "text-decoration": [/^[a-z -]+$/i],
      },
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noreferrer noopener" }),
      img: (tagName, attribs) => ({
        tagName,
        attribs: {
          alt: attribs.alt || "[remote image blocked]",
          title: attribs.title || "Remote image blocked",
          width: attribs.width || "",
          height: attribs.height || "",
        },
      }),
    },
  });
}

export async function parseFullMessage(filePath) {
  const parsed = await simpleParser(fs.createReadStream(filePath), {
    skipHtmlToText: true,
    skipTextToHtml: true,
  });
  const html = parsed.html ? sanitizeEmailHtml(Buffer.isBuffer(parsed.html) ? parsed.html.toString("utf8") : parsed.html) : "";
  return {
    subject: String(parsed.subject || ""),
    from: String(parsed.from?.text || ""),
    to: String(parsed.to?.text || ""),
    cc: String(parsed.cc?.text || ""),
    date: parsed.date instanceof Date && !Number.isNaN(parsed.date.valueOf()) ? parsed.date.toISOString() : "",
    messageId: String(parsed.messageId || ""),
    text: String(parsed.text || ""),
    html,
    attachments: (parsed.attachments || []).map((item, index) => ({
      index,
      filename: String(item.filename || `attachment-${index + 1}`),
      contentType: String(item.contentType || "application/octet-stream"),
      size: Number(item.size || item.content?.length || 0),
      contentId: String(item.contentId || ""),
    })),
  };
}

export async function readAttachment(filePath, targetIndex) {
  const parsed = await simpleParser(fs.createReadStream(filePath), {
    skipHtmlToText: true,
    skipTextToHtml: true,
  });
  const index = Number(targetIndex);
  const item = Number.isInteger(index) ? parsed.attachments?.[index] : null;
  if (!item) return null;
  return {
    filename: String(item.filename || `attachment-${index + 1}`),
    contentType: String(item.contentType || "application/octet-stream"),
    content: Buffer.from(item.content || Buffer.alloc(0)),
  };
}
