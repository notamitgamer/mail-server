import type { ParsedMail, SimpleParserOptions, Source } from './types.js';
/**
 * Called with the parsed message, or with the error that stopped parsing.
 */
export type SimpleParserCallback = (err: Error | null, mail: ParsedMail) => void;
/**
 * Parses a whole message into one object, attachments buffered in memory. Resolves with the
 * parsed message, or calls `callback` with it when one is given.
 *
 * @param input The raw message as a Buffer or a string, or a readable stream of it
 * @param options Parser options, see {@link SimpleParserOptions}
 * @throws {TypeError} When `input` is `null` or `undefined`
 */
declare function simpleParser(input: Source, callback: SimpleParserCallback): void;
declare function simpleParser(input: Source, options: SimpleParserOptions | null | undefined, callback: SimpleParserCallback): void;
declare function simpleParser(input: Source, options?: SimpleParserOptions | null): Promise<ParsedMail>;
export default simpleParser;
