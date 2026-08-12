// Deterministic PNG encoder (node, no deps) — generates the test capture image.
// RGBA rows → PNG via zlib.deflateSync + hand-rolled CRC32.
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// pixels: Uint8ClampedArray RGBA, width*height*4
export function encodePng(width, height, pixels) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    pixels.copy ? pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4) : raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// Deterministic 800x600 test capture: 16px checkerboard, per-quadrant tints,
// a 2px magenta border, and a 40px corner marker in each quadrant. Any
// annotation rendered over this is detectable in pixel comparisons.
export function makeTestImage(width = 800, height = 600) {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 20 + ((x / 16) | 0) * 3 + ((y / 16) | 0) * 2;
      let g = 30 + ((y / 16) | 0) * 4;
      let b = 40 + ((x / 16) | 0) * 2;
      // quadrant tints
      if (x > width / 2) r += 30;
      if (y > height / 2) b += 40;
      // checkerboard shade
      if (((x / 16) | 0) % 2 === ((y / 16) | 0) % 2) {
        r = Math.min(255, r + 25);
        g = Math.min(255, g + 25);
      }
      // border
      if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) {
        r = 255; g = 0; b = 255;
      }
      const i = (y * width + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return { width, height, png: encodePng(width, height, px) };
}

export function pngToDataUrl(pngBuffer) {
  return `data:image/png;base64,${pngBuffer.toString("base64")}`;
}
