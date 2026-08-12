/**
 * Fully static export. The page fetches its data from GitHub at runtime, so a
 * new batch of jobs never needs a redeploy — the hourly workflow just commits
 * data/jobs.json and the live site picks it up on the next load.
 */
/** @type {import('next').NextConfig} */
export default {
  output: 'export',
  images: { unoptimized: true },
};
