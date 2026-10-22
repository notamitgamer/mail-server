import { Buffer } from 'node:buffer';
import type { HeaderLine, HeaderObject, HeaderParam, LibmimeConfig, ParsedHeaderValue, StructuredHeaderValue } from './types.js';
import type * as types from './types.js';
declare class Libmime {
    config: LibmimeConfig;
    constructor(config?: LibmimeConfig);
    /**
     * Checks if a value is plaintext string (uses only printable 7bit chars)
     *
     * When isParam is set the value is destined for a header parameter, so HT, CR and LF
     * are not plaintext either: a header parameter has no way to carry them. HT is a valid
     * fold point, so folding and unfolding a header would rewrite it as a space, and CR/LF
     * cannot appear in a header value at all. DEL is neither a token character nor qtext,
     * so it can not be carried bare or quoted. Such values have to go through the rfc2231
     * parameter continuation encoding instead, the same way non-ASCII text does.
     *
     * @param {String} value String to be tested
     * @param {Boolean} [isParam] Set to true if the value is a header parameter value
     * @returns {Boolean} true if it is a plaintext string
     */
    isPlainText(value: unknown, isParam?: boolean): boolean;
    private isPlainParamValue;
    /**
     * Checks if a multi line string containes lines longer than the selected value.
     *
     * Useful when detecting if a mail message needs any processing at all:
     * if only plaintext characters are used and lines are short, then there is
     * no need to encode the values in any way. If the value is plaintext but has
     * longer lines then allowed, then use format=flowed
     *
     * @param {String} str String to be tested
     * @param {Number} lineLength Max line length to check for
     * @returns {Boolean} Returns true if there is at least one line longer than lineLength chars
     */
    hasLongerLines(str: string, lineLength: number): boolean;
    /**
     * Decodes a string from a format=flowed soft wrapping.
     *
     * @param {String} str Plaintext string with format=flowed to decode
     * @param {Boolean} [delSp] If true, delete leading spaces (delsp=yes)
     * @return {String} Mime decoded string
     */
    decodeFlowed(input: unknown, delSp?: boolean): string;
    /**
     * Adds soft line breaks to content marked with format=flowed to
     * ensure that no line in the message is never longer than lineLength
     *
     * @param {String} str Plaintext string that requires wrapping
     * @param {Number} [lineLength=76] Maximum length of a line
     * @return {String} String with forced line breaks
     */
    encodeFlowed(str: string, lineLength?: number): string;
    /**
     * Encodes a string or an Buffer to an UTF-8 MIME Word (rfc2047)
     *
     * @param {String|Buffer} data String to be encoded
     * @param {String} mimeWordEncoding='Q' Encoding for the mime word, either Q or B
     * @param {Number} [maxLength=0] If set, split mime words into several chunks if needed
     * @return {String} Single or several mime words joined together
     */
    encodeWord(data: string | Buffer, mimeWordEncoding?: string, maxLength?: number): string;
    /**
     * Normalizes a charset name to its canonical form, resolving common aliases and
     * invalid names. For example `iso-8859-8-i` and `iso-8859-8-e` become `ISO-8859-8`
     * and `win-1257` becomes `windows-1257`. Unknown charsets are returned uppercased.
     * Missing or non-string input defaults to `UTF-8`.
     *
     * @param {String} charset Charset name to normalize
     * @return {String} Canonical charset name
     */
    normalizeCharset(charset?: unknown): string;
    /**
     * Decodes the inner payload of a single mime encoded-word into a unicode string.
     * Expects the three components of `=?charset?encoding?text?=` already separated.
     *
     * @param {String} charset Charset name from the encoded-word (may include an RFC 2231 language tag, which is ignored)
     * @param {String} encoding Encoding indicator, either 'Q' or 'B' (case insensitive)
     * @param {String} str Encoded payload between the second `?` and the trailing `?=`
     * @return {String} Decoded unicode string
     */
    decodeWord(charset: string, encoding: string, str: string): string;
    /**
     * Finds word sequences with non ascii text and converts these to mime words
     *
     * @param {String|Buffer} data String to be encoded
     * @param {String} mimeWordEncoding='Q' Encoding for the mime word, either Q or B
     * @param {Number} [maxLength=0] If set, split mime words into several chunks if needed
     * @param {String} [fromCharset='UTF-8'] Source character set
     * @return {String} String with possible mime words
     */
    encodeWords(data: string | Buffer, mimeWordEncoding?: string, maxLength?: number | string, fromCharset?: string): string;
    /**
     * Decode a string that might include one or several mime words
     *
     * @param {String} str String including some mime words that will be decoded
     * @return {String} Decoded unicode string
     */
    decodeWords(str: unknown): string;
    getHex(c: number | undefined): string | false;
    /**
     * Splits a string by :
     * The result is not mime word decoded, you need to do your own decoding based
     * on the rules for the specific header key
     *
     * @param {String} headerLine Single header line, might include linebreaks as well if folded
     * @return {Object} An object of {key, value}
     */
    decodeHeader(headerLine: unknown): HeaderLine;
    /**
     * Parses a block of header lines. Does not decode mime words as every
     * header might have its own rules (eg. formatted email addresses and such)
     *
     * @param {String} headers Headers string
     * @return {Object} An object of headers, where header keys are object keys and every value is an Array of the values for that key
     */
    decodeHeaders(headers: string): HeaderObject;
    /**
     * Joins parsed header value together as 'value; param1=value1; param2=value2'
     * PS: We are following RFC 822 for the list of special characters that we need to keep in quotes.
     *      Refer: https://www.w3.org/Protocols/rfc1341/4_Content-Type.html
     * @param {Object} structured Parsed header value
     * @return {String} joined header value
     */
    buildHeaderValue(structured: StructuredHeaderValue): string;
    /**
     * Parses a header value with key=value arguments into a structured
     * object.
     *
     *   parseHeaderValue('text/plain; CHARSET=UTF-8') ->
     *   {
     *     'value': 'text/plain',
     *     'params': {
     *       'charset': 'UTF-8'
     *     }
     *   }
     *
     * The result also carries a non-enumerable `decodedParams` array that names the params
     * assembled from rfc2231 segments (title*=, title*0*=, title*0=). Those values are already
     * decoded, so a caller that runs decodeWords() over the params has to leave them out
     *
     * @param {String} str Header value
     * @return {Object} Header value as a parsed structure
     */
    parseHeaderValue(str: string): ParsedHeaderValue;
    /**
     * Encodes a string or an Buffer to an UTF-8 Parameter Value Continuation encoding (rfc2231)
     * Useful for splitting long parameter values.
     *
     * For example
     *      title="unicode string"
     * becomes
     *     title*0*=utf-8''unicode
     *     title*1*=%20string
     *
     * @param {String} key Parameter name (eg. 'filename')
     * @param {String|Buffer} data String to be encoded
     * @param {Number} [maxLength=50] Max length for generated chunks
     * @param {String} [fromCharset='UTF-8'] Source character set
     * @return {Array} A list of encoded keys and headers
     */
    buildHeaderParam(key: string, data: unknown, maxLength?: number, fromCharset?: string): HeaderParam[];
    /**
     * Returns file extension for a content type string. If no suitable extensions
     * are found, 'bin' is used as the default extension
     *
     * @param {String} mimeType Content type to be checked for
     * @return {String} File extension
     */
    detectExtension(input: unknown): string;
    /**
     * Returns content type for a file extension. If no suitable content types
     * are found, 'application/octet-stream' is used as the default content type
     *
     * @param {String} extension Extension (or filename) to be checked for
     * @return {String} Content type
     */
    detectMimeType(input: unknown): string;
    /**
     * Folds long lines, useful for folding header lines (afterSpace=false) and
     * flowed text (afterSpace=true)
     *
     * @param {String} str String to be folded
     * @param {Number} [lineLength=76] Maximum length of a line
     * @param {Boolean} afterSpace If true, leave a space in the end of a line
     * @return {String} String with folded lines
     */
    foldLines(input: unknown, lineLength?: number, afterSpace?: boolean): string;
    /**
     * Splits a mime encoded string. Needed for dividing mime words into smaller chunks
     *
     * @param {String} str Mime encoded string to be split up
     * @param {Number} maxlen Maximum length of characters for one part (minimum 12)
     * @return {Array} Split string
     */
    splitMimeEncodedString(str: string, maxlen?: number): string[];
    encodeURICharComponent(chr: string): string;
    safeEncodeURIComponent(input: unknown): string;
}
/**
 * The shared instance, the default export of the package. The class is attached to it as `Libmime`,
 * so `require('libmime').Libmime` keeps working
 */
declare const libmime: Libmime & {
    Libmime: typeof Libmime;
};
type LibmimeInstance = Libmime;
declare namespace libmime {
    type Libmime = LibmimeInstance;
    type HeaderLine = types.HeaderLine;
    type HeaderObject = types.HeaderObject;
    type HeaderParam = types.HeaderParam;
    type LibmimeConfig = types.LibmimeConfig;
    type MimeWordEncoding = types.MimeWordEncoding;
    type ParsedHeaderValue = types.ParsedHeaderValue;
    type StructuredHeader = types.StructuredHeader;
    type StructuredHeaderValue = types.StructuredHeaderValue;
}
export = libmime;
