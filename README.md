# HNS Decision Tool Dashboard

This project implements a Next.js App Router application that accepts public decision‑tool submissions and exposes a password‑protected dashboard.  It fulfils the requirements provided in the build specification.

## Features

- **Public ingestion endpoint**: `POST /api/hns/submit` accepts JSON payloads from the decision tool.  It validates the payload (consent must be `true`, a honeypot field is rejected and `ratedCount` must be greater than zero), applies strict CORS only allowing `https://www.sleepapneaimplant.org` and `https://sleepapneaimplant.org`, and inserts the record into the `public.hns_responses` table on Supabase via the service role key.  All UTM parameters, scores, recommendations and demographics are persisted.
- **Password‑protected dashboard**: `/login` allows a user with an existing Supabase Auth email/password to sign in.  `/dashboard` is a server component that checks for a valid session; unauthenticated users are redirected back to `/login`.  Once authenticated the dashboard displays:
  - KPI cards for total responses, Inspire/Genio/Tie counts and the last 7 days of responses.
  - A distribution table of recommendations.
  - Stacked breakdown tables across demographic fields such as `ageRange`, `sexAtBirth`, `bmiRange`, `insurance`, `cpap`, `stage`, `heard`, `country` and `state`.
  - Average slider values (from the `priorities` JSON) grouped by recommendation.
  - A frequency table of the most common `topReasons` values.
  - A raw table of all responses with a CSV export link.

## Project structure

```
hns-app/
├── README.md          – this file
├── package.json       – dependencies and scripts
├── next.config.js     – Next.js configuration
├── tsconfig.json      – TypeScript configuration
├── next-env.d.ts      – TypeScript definitions for Next.js
├── src/
│   ├── app/
│   │   ├── page.tsx            – redirects `/` to the login page
│   │   ├── login/page.tsx      – client component for email/password login
│   │   ├── dashboard/page.tsx  – protected dashboard displaying analytics
│   │   └── api/
│   │       └── hns/
│   │           └── submit/route.ts – public ingestion endpoint
│   └── lib/
│       └── supabase/
│           ├── client.ts       – helper to create a browser client
│           ├── server.ts       – helper to create a server client (uses cookies)
│           └── admin.ts        – helper to create an admin client with the service role key
└── hns-app.zip         – zipped copy of the project (for convenience)
```

## Environment variables

The application uses environment variables for its Supabase configuration.  When deploying to Vercel you should configure the following variables:

| Variable                           | Purpose                                                                                 |
|------------------------------------|-----------------------------------------------------------------------------------------|
| `NEXT_PUBLIC_SUPABASE_URL`         | The base URL of your Supabase instance (e.g. `https://your-project.supabase.co`).        |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`    | The anon key used for client‑side operations and session validation.                     |
| `SUPABASE_URL`                     | Same as above but not exposed to the browser (used by the admin client).                |
| `SUPABASE_SERVICE_ROLE_KEY`        | Supabase service role key used only on the server for inserts and unrestricted reads.    |

The service role key **must never be exposed to the browser**.  Vercel provides the ability to mark environment variables as **encrypted** / **secret** so they are only available on the server.

### Configuring CORS

The ingestion endpoint implements manual CORS headers.  Only requests originating from `https://www.sleepapneaimplant.org` and `https://sleepapneaimplant.org` are accepted.  If you need to allow additional origins you may update the `ALLOWED_ORIGINS` set in `src/app/api/hns/submit/route.ts`.

## Running locally

To develop locally you will need to install the dependencies and run the development server.  Note that downloading dependencies requires internet access; if you are developing offline you can still inspect and modify the code, but `npm install` will fail without network connectivity.

```bash
npm install
npm run dev
```

The app will start on `http://localhost:3000` by default.  Environment variables can be placed in a `.env.local` file at the root of the project.

## Deployment

Deploy this project to Vercel using the standard Next.js workflow:

1. Push the project to a Git repository (e.g. GitHub).
2. Create a new project in Vercel and import the repository.
3. Set the required environment variables in the Vercel dashboard (see above).  Be sure to mark `SUPABASE_SERVICE_ROLE_KEY` as **encrypted** or **secret** so it is not exposed to the frontend.
4. Vercel will build and deploy your project automatically.  The ingestion endpoint will be available at `{vercel-url}/api/hns/submit` and the dashboard at `{vercel-url}/dashboard` (after logging in via `{vercel-url}/login`).

## Credentials and sign‑ups

The dashboard uses Supabase Auth for login.  Sign‑ups should remain disabled in Supabase, and you must manually create users via the Supabase dashboard or SQL.  Use the email/password you created for the admin user to log into `/login`.

## Security considerations

- **Service role key**: The service role key bypasses Row Level Security.  It is only used server‑side (in API routes and server components).  Never expose it to the browser or commit it to your repository.
- **CORS**: Only the specified domains are allowed to submit responses.  Requests from other origins will be rejected.
- **Payload validation**: The ingestion endpoint rejects requests that do not include consent, that include a `honeypot` field, or that have `ratedCount` less than 1.
- **Authentication**: All dashboard pages are wrapped with a session check.  If the session is invalid or missing the user will be redirected to the login page.

## Limitations

This implementation intentionally uses simple tables instead of charts to visualise the breakdowns.  The project includes `chart.js` and `react-chartjs-2` as dependencies in `package.json`, so you may later enhance the dashboard with charts if desired.  The data aggregation is done in memory; for very large datasets you may consider offloading aggregation to Supabase using SQL queries or stored procedures.
.
