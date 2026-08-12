import { readFileSync, writeFileSync } from 'node:fs';
import type { Job } from './types.js';
import { renderEmail, subject } from './email.js';
import { isFreshEnough } from './filter.js';

/** Renders the last dry run's matches to out/preview.html so you can eyeball it. */
const matches = JSON.parse(readFileSync('out/matches.json', 'utf8')) as Job[];
const fresh = matches.filter((j) => isFreshEnough(j.postedAt));
const stale = matches.filter((j) => !isFreshEnough(j.postedAt));
writeFileSync('out/preview.html', renderEmail(fresh, stale));

console.log(`subject: [jobs] ${subject(fresh, stale)}`);
console.log(`${matches.length} matches (${fresh.length} fresh, ${stale.length} backlog), ${matches.filter((j) => j.postedAt).length} with a posted date`);
console.log('open out/preview.html');
