/**
 * Camera lifecycle manager — singleton camera stream shared across modules.
 * Prevents duplicate streams when switching sections.
 */

type CameraCallback = (stream: MediaStream) => void;
type CameraErrorCallback = (error: Error) => void;

class CameraManagerClass {
  private stream: MediaStream | null = null;
  private listeners = new Set<CameraCallback>();
  private errorListeners = new Set<CameraErrorCallback>();
  private startPromise: Promise<MediaStream> | null = null;

  async start(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    if (this.stream?.active) return this.stream;
    if (this.startPromise) return this.startPromise;

    this.startPromise = navigator.mediaDevices.getUserMedia(
      constraints ?? { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }
    ).then(stream => {
      this.stream = stream;
      this.startPromise = null;
      this.listeners.forEach(cb => cb(stream));
      return stream;
    }).catch(err => {
      this.startPromise = null;
      const error = err instanceof Error ? err : new Error(String(err));
      this.errorListeners.forEach(cb => cb(error));
      throw error;
    });

    return this.startPromise;
  }

  stop() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.startPromise = null;
  }

  getStream() { return this.stream; }
  isActive() { return Boolean(this.stream?.active); }

  onStream(cb: CameraCallback) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  onError(cb: CameraErrorCallback) { this.errorListeners.add(cb); return () => this.errorListeners.delete(cb); }
}

export const CameraManager = new CameraManagerClass();
