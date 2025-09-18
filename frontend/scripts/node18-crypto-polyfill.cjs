const crypto = require('node:crypto');

if (typeof crypto.hash !== 'function') {
  const normalizeInput = (value) => {
    if (value == null) {
      throw new TypeError('crypto.hash polyfill requires data to be provided');
    }

    if (typeof value === 'string' || Buffer.isBuffer(value)) {
      return value;
    }

    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }

    if (value instanceof ArrayBuffer) {
      return Buffer.from(value);
    }

    throw new TypeError(`Unsupported data type passed to crypto.hash polyfill: ${typeof value}`);
  };

  const resolveEncoding = (encodingOrOptions) => {
    if (!encodingOrOptions) {
      return undefined;
    }

    if (typeof encodingOrOptions === 'string') {
      return encodingOrOptions;
    }

    if (typeof encodingOrOptions === 'object') {
      return (
        encodingOrOptions.encoding ||
        encodingOrOptions.outputEncoding ||
        encodingOrOptions.outputFormat ||
        encodingOrOptions.format ||
        undefined
      );
    }

    throw new TypeError('Invalid output encoding passed to crypto.hash polyfill');
  };

  const polyfill = async (algorithm, data, encodingOrOptions) => {
    const normalizedData = normalizeInput(data);
    const hash = crypto.createHash(algorithm);
    hash.update(normalizedData);

    const encoding = resolveEncoding(encodingOrOptions);
    return encoding ? hash.digest(encoding) : hash.digest();
  };

  Object.defineProperty(crypto, 'hash', {
    value: polyfill,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

module.exports = {};
