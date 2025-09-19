declare module 'exifr' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function parse(data: ArrayBuffer | Buffer, options?: Record<string, any>): Promise<any>;
}
