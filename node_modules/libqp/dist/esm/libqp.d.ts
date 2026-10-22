import { Transform, type TransformOptions } from 'node:stream';
/**
 * Encodes a Buffer into a Quoted-Printable encoded string
 *
 * @param buffer Buffer to convert, a string is encoded as UTF-8
 * @returns Quoted-Printable encoded string
 */
export declare function encode(buffer: Buffer | Uint8Array | string): string;
/**
 * Decodes a Quoted-Printable encoded string to a Buffer object
 *
 * @param str Quoted-Printable encoded string. A Buffer is read byte for byte, so raw 8-bit bytes
 *        in the input are copied to the output unchanged. A char of a string is copied as the low
 *        byte of its char code, so a string should only hold chars below 256 ('binary')
 * @returns Decoded value
 */
export declare function decode(str: string | Buffer | Uint8Array): Buffer;
/**
 * Adds soft line breaks to a Quoted-Printable string
 *
 * @param str Quoted-Printable encoded string that might need line wrapping
 * @param [lineLength=76] Maximum allowed length for a line, at least 4
 * @returns Soft-wrapped Quoted-Printable encoded string
 */
export declare function wrap(str: string, lineLength?: number): string;
/**
 * Options for the Quoted-Printable encoder stream, on top of the Transform stream options
 */
export interface EncoderOptions extends TransformOptions {
    /** Maximum length for lines (76 by default), set to false to disable wrapping */
    lineLength?: number | false | undefined;
    /** The input is binary data: a CR or LF that is not part of a CRLF pair is encoded */
    binary?: boolean | undefined;
}
/**
 * Options for the Quoted-Printable decoder stream, the Transform stream options
 */
export type DecoderOptions = TransformOptions;
/**
 * Creates a transform stream for encoding data to Quoted-Printable encoding
 */
export declare class Encoder extends Transform {
    options: EncoderOptions;
    inputBytes: number;
    outputBytes: number;
    /**
     * @param [options] Stream options
     * @param [options.lineLength=76] Maximum length for lines, set to false to disable wrapping
     * @param [options.binary=false] Encode every CR or LF that is not part of a CRLF pair
     */
    constructor(options?: EncoderOptions);
}
/**
 * Creates a transform stream for decoding Quoted-Printable encoded strings.
 * The input is not actually processed as a stream but concatted and processed as a single input,
 * so escapes and soft line breaks split across chunks decode the same as unsplit input
 */
export declare class Decoder extends Transform {
    options: DecoderOptions;
    inputBytes: number;
    outputBytes: number;
    /**
     * @param [options] Stream options
     */
    constructor(options?: DecoderOptions);
}
declare const libqp: {
    encode: typeof encode;
    decode: typeof decode;
    wrap: typeof wrap;
    Encoder: typeof Encoder;
    Decoder: typeof Decoder;
};
export default libqp;
