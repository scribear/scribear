export {};

declare module 'vitest' {
  export interface ProvidedContext {
    /** Base URL of the in-process Session Manager (`http://127.0.0.1:<port>`). */
    sessionManagerBaseUrl: string;
    /** Base URL of the live Transcription Service container (`http://host:port`). */
    transcriptionServiceBaseUrl: string;
    /** Admin API key the test bootstrap signed Session Manager with. */
    adminApiKey: string;
    /** Service-to-service API key shared between Session Manager and Node Server. */
    serviceApiKey: string;
    /** HMAC signing key shared between Session Manager and Node Server. */
    sessionTokenSigningKey: string;
    /** API key the live Transcription Service expects on its WS handshake. */
    transcriptionApiKey: string;
  }
}
