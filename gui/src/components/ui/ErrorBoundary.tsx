import React from 'react';
import { api } from '../../lib/api';
import Logo from './Logo';

/* Ronin Code — render-error boundary around the app shell.
   A crashing component must never white-screen the product: show a calm
   bilingual fallback, report the error to the host (best-effort,
   metadata only), and offer a reload. User work lives on disk / in the
   host, so a reload loses nothing. */

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    void api.logClientError({ message: error.message, stack: error.stack }).catch(() => {
      /* best-effort — the host may itself be down */
    });
  }

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;
    const fa = document.documentElement.lang === 'fa';
    return (
      <div className="error-boundary">
        <div className="error-boundary-card">
          <Logo />
          <h1>{fa ? 'یه مشکلی پیش اومد' : 'Something went wrong'}</h1>
          <p>
            {fa
              ? 'رونین به یه خطای غیرمنتظره خورد. کارت روی همین دستگاه ذخیره شده — برای ادامه، دوباره بارگذاری کن.'
              : 'Ronin hit an unexpected error. Your work is saved on this device — reload to continue.'}
          </p>
          <p className="error-boundary-alt" lang={fa ? 'en' : 'fa'} dir={fa ? 'ltr' : 'rtl'}>
            {fa
              ? 'Ronin hit an unexpected error. Your work is saved on this device — reload to continue.'
              : 'رونین به یه خطای غیرمنتظره خورد. کارت روی همین دستگاه ذخیره شده — برای ادامه، دوباره بارگذاری کن.'}
          </p>
          <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
            {fa ? 'بارگذاری دوباره' : 'Reload'} · {fa ? 'Reload' : 'بارگذاری دوباره'}
          </button>
        </div>
      </div>
    );
  }
}
