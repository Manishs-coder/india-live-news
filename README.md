# India Live News Dashboard

Live RSS news dashboard for Indian news and Bollywood sources.

## Features

- India and Bollywood categories
- Source tabs
- Search
- Auto-refresh
- Mobile-friendly layout
- Rewrite desk for authors
- Saved rewritten stories with copy-ready website text

## Run locally

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

## Deploy

Use a Node web service.

- Build command: `npm install`
- Start command: `npm start`

## Password protection

Set these environment variables on your hosting provider:

- `ADMIN_USER`
- `ADMIN_PASSWORD`
- `DATA_DIR`

If `ADMIN_PASSWORD` is set, the app asks for a username and password before showing any page or API data.

Admin users can visit `/admin` to create logins for:

- agent
- author
- freelancer
- admin

For production, set `DATA_DIR` to a persistent folder or database-backed storage so created logins survive server restarts.

## Rewrite workflow

Authors can open the dashboard, click `Rewrite` on any story, rewrite the headline and body in their own words, then save it. Saved rewrites appear in the Rewrite desk and can be copied for posting on a website.

For production, rewrites also need persistent storage through `DATA_DIR`, a Render persistent disk, or a database.
