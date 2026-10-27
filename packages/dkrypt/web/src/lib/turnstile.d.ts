export {};

declare global {
  interface Window {
    turnstile?: {
      render(target: HTMLElement, options: { sitekey: string; action: string; callback(token: string): void; 'error-callback'(): void; 'expired-callback'(): void }): string;
      remove(widgetId: string): void;
      reset(widgetId?: string): void;
    };
  }
}
