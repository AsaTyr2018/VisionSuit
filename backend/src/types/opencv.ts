export interface Mat {
  readonly rows: number;
  readonly cols: number;
  readonly data: Uint8Array;
  readonly data32S: Int32Array;
  readonly data64F: Float64Array;
  empty(): boolean;
  delete(): void;
  setTo(value: Scalar | number[]): void;
  clone(): Mat;
  copyTo(dst: Mat): void;
  roi(rect: Rect): Mat;
  intPtr(row: number, col: number): Int32Array;
  doublePtr(row: number, col: number): Float64Array;
  intAt(row: number, col: number): number;
  doubleAt(row: number, col: number): number;
  type(): number;
}

export interface MatConstructor {
  new (): Mat;
  new (rows: number, cols: number, type: number, scalar?: Scalar | number[]): Mat;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Scalar {
  0: number;
  1: number;
  2: number;
  3: number;
}

export interface OpenCVModule {
  readonly Mat: MatConstructor;
  readonly Size: new (width: number, height: number) => Size;
  readonly Rect: new (x: number, y: number, width: number, height: number) => Rect;
  readonly Scalar: new (v0?: number, v1?: number, v2?: number, v3?: number) => Scalar;
  readonly MORPH_ELLIPSE: number;
  readonly MORPH_OPEN: number;
  readonly MORPH_CLOSE: number;
  readonly INTER_AREA: number;
  readonly CV_8UC1: number;
  readonly CV_8UC3: number;
  readonly CV_8UC4: number;
  readonly CV_32S: number;
  readonly IMREAD_COLOR: number;
  readonly COLOR_BGR2HSV: number;
  readonly COLOR_BGR2YCrCb: number;
  readonly COLOR_BGR2RGB: number;
  readonly COLOR_BGR2GRAY: number;
  readonly COLOR_RGBA2BGR: number;
  readonly CC_STAT_AREA: number;
  readonly CC_STAT_LEFT: number;
  readonly CC_STAT_TOP: number;
  readonly CC_STAT_WIDTH: number;
  readonly CC_STAT_HEIGHT: number;
  readonly IMWRITE_JPEG_QUALITY: number;

  matFromArray(rows: number, cols: number, type: number, array: ArrayLike<number>): Mat;
  imdecode(mat: Mat, flags: number): Mat;
  imencode(ext: string, mat: Mat, params?: Mat): Uint8Array;
  resize(src: Mat, dst: Mat, size: Size, fx: number, fy: number, interpolation: number): void;
  cvtColor(src: Mat, dst: Mat, code: number, dstCn?: number): void;
  inRange(src: Mat, lower: Mat, upper: Mat, dst: Mat): void;
  bitwise_and(src1: Mat, src2: Mat, dst: Mat): void;
  morphologyEx(src: Mat, dst: Mat, op: number, kernel: Mat): void;
  getStructuringElement(shape: number, size: Size): Mat;
  countNonZero(mat: Mat): number;
  connectedComponentsWithStats(
    src: Mat,
    labels: Mat,
    stats: Mat,
    centroids: Mat,
    connectivity: number,
    ltype: number,
  ): number;
  Canny(image: Mat, edges: Mat, threshold1: number, threshold2: number, apertureSize?: number, L2gradient?: boolean): void;
  meanStdDev(src: Mat, mean: Mat, stddev: Mat, mask?: Mat): void;
}

export type { Mat as OpenCvMat };
