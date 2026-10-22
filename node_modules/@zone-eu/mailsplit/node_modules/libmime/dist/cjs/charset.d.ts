import { Buffer } from 'node:buffer';
/**
 * Encodes an unicode string into an Buffer object as UTF-8
 *
 * We force UTF-8 here, no strange encodings allowed.
 *
 * @param str String to be encoded
 * @return UTF-8 encoded typed array
 */
export declare function encode(str: string): Buffer;
/**
 * Decodes a string from Buffer to an unicode string using specified encoding.
 * An unknown charset falls back to UTF-8
 *
 * @param buf Binary data to be decoded
 * @param [fromCharset='UTF-8'] Binary data is decoded into string using this charset
 * @return Decoded string
 */
export declare function decode(buf: Buffer | string, fromCharset?: string): string;
/**
 * Convert a string from specific encoding to UTF-8 Buffer
 *
 * @param data String or Buffer to be encoded
 * @param [fromCharset='UTF-8'] Source encoding for the string
 * @return UTF-8 encoded typed array
 */
export declare function convert(data: string | Buffer, fromCharset?: string): Buffer;
/**
 * Converts well known invalid character set names to proper names.
 * eg. win-1257 will be converted to windows-1257. Missing or non-string
 * input defaults to UTF-8.
 *
 * @param charset Charset name to convert
 * @return Canonicalized charset name
 */
export declare function normalizeCharset(charset?: unknown): string;
declare const _default: {
    encode: typeof encode;
    decode: typeof decode;
    convert: typeof convert;
    normalizeCharset: typeof normalizeCharset;
};
export default _default;
