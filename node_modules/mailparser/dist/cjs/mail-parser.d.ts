import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import type { AddressObject, AttachmentStream, EmailAddress, HeaderLines, Headers, MailParserOptions, MessageText } from './types.js';
/**
 * A lower level, streaming e-mail parser. It is a Transform stream: write the raw message in and
 * read the parsed content out. It emits:
 *
 * - a `headers` event with the parsed headers of the message (see {@link Headers}),
 * - a `headerLines` event with the raw header lines,
 * - an {@link AttachmentStream} object for every attachment, whose content stream has to be read
 *   and `release()` called before the parser continues,
 * - one {@link MessageText} object with the text content at the end.
 *
 * For one-shot parsing into a single object, use `simpleParser` instead.
 */
declare class MailParser extends Transform {
    /** The options the parser was created with. */
    options: MailParserOptions;
    /** The parsed headers of the message, `false` until they have been parsed. */
    headers: Headers | false;
    /** The raw header lines of the message, `false` until they have been parsed. */
    headerLines: HeaderLines | false;
    /** The plain text content, `false` until the message has been parsed or when there is none. */
    text: string | false;
    /** The HTML content, `false` until the message has been parsed or when there is none. */
    html: string | false;
    /** The plain text content as HTML, `false` until the message has been parsed or when there is none. */
    textAsHtml: string | false;
    /** The `Subject` header, set once the headers have been parsed. */
    subject?: string;
    /** The `References` header, set once the headers have been parsed. */
    references?: string | string[];
    /** The `Date` header, set once the headers have been parsed. */
    date?: Date;
    /** The `To` header, set once the headers have been parsed. */
    to?: AddressObject | AddressObject[];
    /** The `From` header, set once the headers have been parsed. */
    from?: AddressObject;
    /** The `Cc` header, set once the headers have been parsed. */
    cc?: AddressObject | AddressObject[];
    /** The `Bcc` header, set once the headers have been parsed. */
    bcc?: AddressObject | AddressObject[];
    /** The `Message-ID` header, set once the headers have been parsed. */
    messageId?: string;
    /** The `In-Reply-To` header, set once the headers have been parsed. */
    inReplyTo?: string;
    /** The `Reply-To` header, set once the headers have been parsed. */
    replyTo?: AddressObject;
    constructor(config?: MailParserOptions);
    _transform(chunk: Buffer, encoding: BufferEncoding, done: TransformCallback): void;
    _flush(done: TransformCallback): void;
    /**
     * Turns a `Priority`, `X-Priority`, `X-MSMail-Priority` or `Importance` header value into
     * `'high'`, `'normal'` or `'low'`.
     */
    parsePriority(value: string): 'high' | 'normal' | 'low';
    /**
     * Wraps a Message-ID in angle brackets where they are missing. Returns `false` for an empty value.
     */
    ensureMessageIDFormat(value: string): string | false;
    /**
     * Formats parsed addresses for an HTML context, every value HTML-escaped.
     */
    getAddressesHTML(value: EmailAddress | EmailAddress[]): string;
    /**
     * Formats parsed addresses as plain text, display names quoted.
     */
    getAddressesText(value: EmailAddress | EmailAddress[]): string;
    /**
     * Replaces `cid:` links to image attachments in the HTML content. Call it once the parser has
     * ended. `replaceCallback` is called once for every referenced image attachment and answers with
     * the URL to use instead; `done` gets the updated HTML, or `false` when the message has no HTML.
     * The total length of the URLs written is bounded by `maxInlinedImagesSize`.
     */
    updateImageLinks(replaceCallback: (attachment: AttachmentStream, callback: (err: Error | null | false | undefined, url?: string) => void) => void, done: (err: Error | null, html?: string | false) => void): void;
    /**
     * Converts plain text to HTML the way `textAsHtml` is built: HTML-escaped, paragraphs and line
     * breaks kept, and links turned into anchors unless `skipTextLinks` is set. Returns an empty
     * string when `skipTextToHtml` is set.
     */
    textToHtml(str: string): string;
}
interface MailParser {
    /** Emitted once with the parsed headers of the message. */
    on(event: 'headers', listener: (headers: Headers) => void): this;
    /** Emitted once with the raw header lines of the message. */
    on(event: 'headerLines', listener: (headerLines: HeaderLines) => void): this;
    /** Emitted for every attachment and, at the end, once for the text content. */
    on(event: 'data', listener: (data: AttachmentStream | MessageText) => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
    once(event: 'headers', listener: (headers: Headers) => void): this;
    once(event: 'headerLines', listener: (headerLines: HeaderLines) => void): this;
    once(event: 'data', listener: (data: AttachmentStream | MessageText) => void): this;
    once(event: string | symbol, listener: (...args: any[]) => void): this;
    /** Returns the next attachment or text content object, or `null` when none is buffered. */
    read(size?: number): AttachmentStream | MessageText | null;
}
export default MailParser;
