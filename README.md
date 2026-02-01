# NextBite

AI-Powered Restaurant Recommendations using GitHub Pages + Netlify Functions.

## Architecture

- **Frontend**: Static HTML hosted on GitHub Pages (`docs/`)
- **Backend**: Netlify Functions for serverless API (`netlify/functions/`)

## Setup

### 1. Deploy Frontend to GitHub Pages

1. Push this repo to GitHub
2. Go to Settings > Pages
3. Source: main branch, `/docs` folder
4. Save

### 2. Deploy Backend to Netlify

1. Go to netlify.com and sign up with GitHub
2. Import this repository
3. Configure build settings:
   - Build command: (leave empty)
   - Publish directory: (leave empty)
   - Functions directory: netlify/functions
4. Add environment variables:
   - `GEMINI_API_KEY`: Your Google Gemini API key
   - `FOURSQUARE_API_KEY`: Your Foursquare API key (optional)
5. Deploy

### 3. Update Frontend API URL

Edit `docs/index.html` and update `API_URL` to your Netlify site URL.

## Local Development

```bash
npm install
npm run dev
```

Access at http://localhost:8888

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| GEMINI_API_KEY | Yes | Google Gemini API key |
| FOURSQUARE_API_KEY | No | Foursquare Places API key |
