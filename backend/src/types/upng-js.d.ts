declare module 'upng-js' {
  interface UPNGImage {
    width: number;
    height: number;
    data: Uint8Array;
    frames?: unknown[];
    tabs?: Record<string, unknown>;
  }

  interface UPNGStatic {
    decode(data: ArrayBuffer | ArrayBufferView | Buffer): UPNGImage;
    encode(
      frames: ArrayBuffer[] | Uint8Array[] | ArrayLike<ArrayBuffer>,
      width: number,
      height: number,
      compression?: number,
      delays?: number[],
      frags?: unknown[],
    ): ArrayBuffer;
    toRGBA8(image: UPNGImage): ArrayBuffer[];
  }

  const UPNG: UPNGStatic;
  export default UPNG;
}
