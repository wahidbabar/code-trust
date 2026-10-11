// The build-time variables this site reads. Vite inlines them into the bundle.
interface ImportMetaEnv {
  /** The CodeTrustApi Function URL. Required by `vite build`; dev uses the `/api` proxy instead. */
  readonly VITE_API_URL?: string;
}
