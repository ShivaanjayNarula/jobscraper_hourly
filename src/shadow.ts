import type { Company, RawJob } from './types.js';

export interface ShadowReportEntry {
  board: string;
  ats: string;
  token: string;
  primaryCount: number;
  secondaryCount: number;
  missingInSecondary: string[];
  extraInSecondary: string[];
  fieldDifferences: string[];
  primaryError?: string;
  secondaryError?: string;
  primaryDurationMs: number;
  secondaryDurationMs: number;
}

export function compareShadowResults(
  company: Company,
  primaryJobs: RawJob[],
  primaryError: string | undefined,
  primaryDuration: number,
  secondaryJobs: RawJob[],
  secondaryError: string | undefined,
  secondaryDuration: number
): ShadowReportEntry {
  const pMap = new Map(primaryJobs.map((j) => [j.externalId, j]));
  const sMap = new Map(secondaryJobs.map((j) => [j.externalId, j]));

  const missingInSecondary: string[] = [];
  const extraInSecondary: string[] = [];
  const fieldDifferences: string[] = [];

  for (const [id, pJob] of pMap) {
    const sJob = sMap.get(id);
    if (!sJob) {
      missingInSecondary.push(id);
    } else {
      // Check required fields completeness
      const pFields = [pJob.title, pJob.location, pJob.url, pJob.text, pJob.salary].filter(Boolean).length;
      const sFields = [sJob.title, sJob.location, sJob.url, sJob.text, sJob.salary].filter(Boolean).length;
      if (pFields !== sFields) {
        fieldDifferences.push(`${id}: primary has ${pFields} fields, secondary has ${sFields}`);
      }
    }
  }

  for (const id of sMap.keys()) {
    if (!pMap.has(id)) {
      extraInSecondary.push(id);
    }
  }

  return {
    board: company.name,
    ats: company.ats,
    token: company.token,
    primaryCount: primaryJobs.length,
    secondaryCount: secondaryJobs.length,
    missingInSecondary,
    extraInSecondary,
    fieldDifferences,
    primaryError,
    secondaryError,
    primaryDurationMs: primaryDuration,
    secondaryDurationMs: secondaryDuration,
  };
}
