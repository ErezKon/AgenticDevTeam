import * as Sentry from '@sentry/react';
import { BrowserTracing } from '@sentry/tracing';

Sentry.init({
  dsn: process.env.REACT_APP_SENTRY_DSN,
  integrations: [new BrowserTracing()],
  // Adjust this value in production as needed
  tracesSampleRate: 1.0,
  environment: process.env.NODE_ENV,
});

export default Sentry;
