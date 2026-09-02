/**
 * The job page fetches its data from GitHub at runtime ('use client'), so a
 * new batch of jobs still never needs a redeploy — the hourly workflow just
 * commits data/jobs.json and the live site picks it up on the next load.
 *
 * `output: 'export'` was removed when the deployed cold-emailer landed: the
 * /api/outreach/* routes that record clicks need a serverless function, which
 * static export forbids. Nothing else changed — there are still no server
 * components reading request state.
 */
/** @type {import('next').NextConfig} */
export default {
  images: { unoptimized: true },
};
