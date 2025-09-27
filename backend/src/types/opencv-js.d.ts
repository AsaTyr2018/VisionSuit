declare module '@techstark/opencv-js' {
  import type { OpenCVModule } from './opencv';
  const cv:
    | Promise<OpenCVModule>
    | (OpenCVModule & { ready?: Promise<void>; onRuntimeInitialized?: () => void });
  export default cv;
}
