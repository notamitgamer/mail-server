"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Decoder = exports.Encoder = void 0;
exports.encode = encode;
exports.decode = decode;
exports.wrap = wrap;
const node_buffer_1 = require("node:buffer");
const node_stream_1 = require("node:stream");
/**
 * Encodes a Buffer into a base64 encoded string
 *
 * @param buffer Buffer or unicode string to convert
 * @returns base64 encoded string
 */
function encode(buffer) {
    if (typeof buffer === 'string') {
        return node_buffer_1.Buffer.from(buffer, 'utf-8').toString('base64');
    }
    if (!node_buffer_1.Buffer.isBuffer(buffer)) {
        // a plain Uint8Array has no base64 toString(), it would turn into a list of numbers
        return node_buffer_1.Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString('base64');
    }
    return buffer.toString('base64');
}
/**
 * Decodes a base64 encoded string to a Buffer object
 *
 * @param str base64 encoded string
 * @returns Decoded value
 */
function decode(str) {
    str = str || '';
    // Buffer.from() stops decoding at the first padding char, so input made of several
    // padded segments (eg. every line padded on its own) is decoded segment by segment.
    // Segments are found with indexOf and written into one buffer: splitting the input and
    // keeping a Buffer per segment cost memory per segment, tens of times the input size
    // for a body that pads every line.
    if (typeof str === 'string') {
        // Buffer reads only the low byte of a character, "Ł" (U+0141) would be decoded as "A".
        // Characters outside of latin1 are not base64 characters, they are skipped like the rest
        if (/[^\u0000-\u00ff]/.test(str)) {
            str = str.replace(/[^\u0000-\u00ff]+/g, '');
        }
        let padPos = str.indexOf('=');
        if (padPos >= 0 && /[a-zA-Z0-9+/\-_]/.test(str.slice(padPos))) {
            // a segment of n characters decodes to at most n * 3 / 4 bytes
            let output = node_buffer_1.Buffer.alloc(Math.floor((str.length * 3) / 4));
            let length = 0;
            let start = 0;
            while (start <= str.length) {
                let end = str.indexOf('=', start);
                if (end < 0) {
                    end = str.length;
                }
                if (end > start) {
                    length += output.write(str.substring(start, end), length, 'base64');
                }
                start = end + 1;
            }
            // copied out so the result does not keep the oversized buffer alive
            return node_buffer_1.Buffer.from(output.subarray(0, length));
        }
    }
    // a Buffer is copied as it is, the encoding argument only applies to strings
    return node_buffer_1.Buffer.from(str, 'base64');
}
/**
 * Turns a line length option into a whole number of characters, the default for anything unusable
 */
function normalizeLineLength(lineLength) {
    let length = Math.floor(Number(lineLength));
    return Number.isFinite(length) && length >= 1 ? length : 76;
}
/**
 * Splits the bytes of `src` into lines of `lineLength` bytes, each followed by a line break. With
 * `final` set the last line, which may be shorter, gets no line break; otherwise only complete lines
 * are taken and the rest is left for the caller
 *
 * @param src Bytes to wrap
 * @param lineLength Line length
 * @param final Whether `src` ends the output
 * @returns The wrapped bytes and the number of trailing bytes not taken
 */
function wrapBuffer(src, lineLength, final) {
    let lines = Math.ceil(src.length / lineLength);
    // the last line waits for more data unless this is the end: whether it gets a line break depends on
    // whether anything follows it
    let complete = Math.max(lines - 1, 0);
    let rest = src.length - complete * lineLength;
    let output = node_buffer_1.Buffer.allocUnsafe(complete * (lineLength + 2) + (final ? rest : 0));
    let to = 0;
    for (let from = 0; from < complete * lineLength; from += lineLength) {
        src.copy(output, to, from, from + lineLength);
        to += lineLength;
        output[to++] = 0x0d;
        output[to++] = 0x0a;
    }
    if (final) {
        to += src.copy(output, to, complete * lineLength);
        rest = 0;
    }
    if (to !== output.length) {
        // never hand out bytes of the unfilled allocation
        throw new Error('Unexpected wrapped length');
    }
    return { output, rest };
}
/**
 * Adds soft line breaks to a base64 string
 *
 * @param str base64 encoded string that might need line wrapping
 * @param [lineLength=76] Maximum allowed length for a line
 * @returns Soft-wrapped base64 encoded string
 */
function wrap(str, lineLength) {
    str = (str || '').toString();
    let length = normalizeLineLength(lineLength);
    if (str.length <= length) {
        return str;
    }
    if (/[^\u0000-\u00ff]|[\r\n]/.test(str) || str.trim() !== str) {
        // not a plain base64 string, keep the line based behaviour for whatever this is
        return legacyWrap(str, length);
    }
    return wrapBuffer(node_buffer_1.Buffer.from(str, 'latin1'), length, true).output.toString('latin1');
}
/**
 * Line wrapping for input that is not a plain base64 string: line breaks already in the input end a
 * line, and surrounding whitespace is trimmed
 */
function legacyWrap(str, lineLength) {
    let result = [];
    let pos = 0;
    let chunkLength = lineLength * 1024;
    let wrapRegex = new RegExp('.{' + lineLength + '}', 'g');
    while (pos < str.length) {
        let wrappedLines = str
            .slice(pos, pos + chunkLength)
            .replace(wrapRegex, '$&\r\n')
            .trim();
        result.push(wrappedLines);
        pos += chunkLength;
    }
    return result.join('\r\n').trim();
}
/**
 * Creates a transform stream for encoding data to base64 encoding
 *
 * The output is the same as `wrap(encode(input), lineLength)` no matter how the input is split into
 * chunks: every line but the last one ends with a line break, the last one does not
 */
class Encoder extends node_stream_1.Transform {
    constructor(options) {
        super();
        this.options = options || {};
        if (this.options.lineLength !== false) {
            this.options.lineLength = normalizeLineLength(this.options.lineLength);
        }
        this.skipStartBytes = Number(this.options.skipStartBytes) || 0;
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        this.limitOutputBytes = Number(this.options.limitOutputBytes || this.options.limitOutbutBytes) || 0;
        // startPadding can be used together with skipStartBytes
        this._curLine = this.options.startPadding || '';
        this._remainingBytes = null;
        this.inputBytes = 0;
        this.outputBytes = 0;
    }
    /** @internal */
    _writeChunk(chunk) {
        if (this.skipStartBytes) {
            if (chunk.length <= this.skipStartBytes) {
                this.skipStartBytes -= chunk.length;
                return;
            }
            chunk = chunk.subarray(this.skipStartBytes);
            this.skipStartBytes = 0;
        }
        if (this.limitOutputBytes) {
            if (this.outputBytes >= this.limitOutputBytes) {
                // chunks already processed
                return;
            }
            if (this.outputBytes + chunk.length > this.limitOutputBytes) {
                // use partial chunk
                chunk = chunk.subarray(0, this.limitOutputBytes - this.outputBytes);
            }
        }
        this.outputBytes += chunk.length;
        this.push(chunk);
    }
    /**
     * Emits the encoded characters `b64` that follow the current line, keeping what can not be emitted
     * yet as the new current line
     *
     * @internal
     */
    _emit(b64, final) {
        let src = node_buffer_1.Buffer.from(this._curLine + b64, 'latin1');
        if (!src.length) {
            return;
        }
        if (!this.options.lineLength) {
            this._curLine = '';
            return this._writeChunk(src);
        }
        let { output, rest } = wrapBuffer(src, this.options.lineLength, final);
        this._curLine = rest ? src.toString('latin1', src.length - rest) : '';
        if (output.length) {
            this._writeChunk(output);
        }
    }
    /** @internal */
    _transform(chunk, encoding, done) {
        let buf = encoding !== 'buffer' ? node_buffer_1.Buffer.from(chunk, encoding) : chunk;
        if (!buf.length) {
            return done();
        }
        this.inputBytes += buf.length;
        if (this._remainingBytes) {
            buf = node_buffer_1.Buffer.concat([this._remainingBytes, buf], this._remainingBytes.length + buf.length);
            this._remainingBytes = null;
        }
        let extra = buf.length % 3;
        if (extra) {
            this._remainingBytes = buf.subarray(buf.length - extra);
            buf = buf.subarray(0, buf.length - extra);
        }
        this._emit(encode(buf), false);
        done();
    }
    /** @internal */
    _flush(done) {
        this._emit(this._remainingBytes ? encode(this._remainingBytes) : '', true);
        this._remainingBytes = null;
        done();
    }
}
exports.Encoder = Encoder;
/**
 * Creates a transform stream for decoding base64 encoded strings
 */
class Decoder extends node_stream_1.Transform {
    constructor(options) {
        super();
        this.options = options || {};
        this._curLine = '';
        this.inputBytes = 0;
        this.outputBytes = 0;
    }
    /** @internal */
    _transform(chunk, _encoding, done) {
        if (!chunk || !chunk.length) {
            return done();
        }
        this.inputBytes += chunk.length;
        // latin1 maps every byte to one character. 'ascii' would clear the high bit of a byte, turning
        // stray 8-bit bytes into base64 characters instead of skipping them as decode() does
        let b64 = this._curLine + chunk.toString('latin1');
        this._curLine = '';
        if (/[^a-zA-Z0-9+/=]/.test(b64)) {
            b64 = b64.replace(/[^a-zA-Z0-9+/=]/g, '');
        }
        // everything up to the last padding char ends in complete segments, quartets are
        // only counted from there on as a padding run restarts the quartet alignment
        let padded = '';
        let lastPad = b64.lastIndexOf('=');
        if (lastPad >= 0) {
            padded = b64.slice(0, lastPad + 1);
            b64 = b64.slice(lastPad + 1);
        }
        if (b64.length < 4) {
            this._curLine = b64;
            b64 = '';
        }
        else if (b64.length % 4) {
            this._curLine = b64.slice(-(b64.length % 4));
            b64 = b64.slice(0, b64.length - this._curLine.length);
        }
        b64 = padded + b64;
        if (b64) {
            let buf = decode(b64);
            this.outputBytes += buf.length;
            this.push(buf);
        }
        done();
    }
    /** @internal */
    _flush(done) {
        if (this._curLine) {
            let buf = decode(this._curLine);
            this.outputBytes += buf.length;
            this.push(buf);
            this._curLine = '';
        }
        done();
    }
}
exports.Decoder = Decoder;
// The default export is the same set of members as one object, for `import libbase64 from 'libbase64'`.
// In the CommonJS build `require('libbase64')` returns the exports object and its `.default` is that
// object itself, see scripts/build.js
const libbase64 = {
    encode,
    decode,
    wrap,
    Encoder,
    Decoder
};
exports.default = libbase64;
Object.defineProperty(exports, 'default', { value: exports, enumerable: false, writable: true, configurable: true });
