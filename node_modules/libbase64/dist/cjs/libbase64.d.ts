import { Buffer } from 'node:buffer';
import { Transform } from 'node:stream';
/**
 * Encodes a Buffer into a base64 encoded string
 *
 * @param buffer Buffer or unicode string to convert
 * @returns base64 encoded string
 */
export declare function encode(buffer: Buffer | Uint8Array | string): string;
/**
 * Decodes a base64 encoded string to a Buffer object
 *
 * @param str base64 encoded string
 * @returns Decoded value
 */
export declare function decode(str: string | Buffer | null | undefined): Buffer;
/**
 * Adds soft line breaks to a base64 string
 *
 * @param str base64 encoded string that might need line wrapping
 * @param [lineLength=76] Maximum allowed length for a line
 * @returns Soft-wrapped base64 encoded string
 */
export declare function wrap(str: string | Buffer | null | undefined, lineLength?: number | string | null): string;
/**
 * Options for the base64 encoder stream
 */
export interface EncoderOptions {
    /** Maximum length for lines, 76 by default. Set to false to disable wrapping */
    lineLength?: number | string | false | undefined;
    /** Number of output bytes to drop from the start */
    skipStartBytes?: number | undefined;
    /** Maximum number of output bytes to emit */
    limitOutputBytes?: number | undefined;
    /**
     * Misspelled name of `limitOutputBytes` that earlier versions read, still accepted
     *
     * @deprecated Use `limitOutputBytes`
     */
    limitOutbutBytes?: number | undefined;
    /** Characters to prepend to the first line before wrapping, usually used together with `skipStartBytes` */
    startPadding?: string | undefined;
}
/**
 * Options for the base64 decoder stream, none are used at the moment
 */
export interface DecoderOptions {
    [key: string]: unknown;
}
/**
 * Creates a transform stream for encoding data to base64 encoding
 *
 * The output is the same as `wrap(encode(input), lineLength)` no matter how the input is split into
 * chunks: every line but the last one ends with a line break, the last one does not
 */
export declare class Encoder extends Transform {
    options: EncoderOptions;
    skipStartBytes: number;
    limitOutputBytes: number;
    inputBytes: number;
    outputBytes: number;
    constructor(options?: EncoderOptions);
}
/**
 * Creates a transform stream for decoding base64 encoded strings
 */
export declare class Decoder extends Transform {
    options: DecoderOptions;
    inputBytes: number;
    outputBytes: number;
    constructor(options?: DecoderOptions);
}
declare const libbase64: {
    encode: typeof encode;
    decode: typeof decode;
    wrap: typeof wrap;
    Encoder: typeof Encoder;
    Decoder: typeof Decoder;
};
export default libbase64;
