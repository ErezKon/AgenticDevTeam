import express from 'express';
import path from 'path';

const app = express();

// Security headers
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Serve static files from 'public' (placeholder)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('<html><body>Calculator</body></html>');
});

export default app;
