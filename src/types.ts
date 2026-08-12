export type Ats =
  | 'rendered'
  | 'turbohire'
  | 'darwinbox'
  | 'eightfold'
  | 'phenom'
  | 'atlassian'
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workday'
  | 'oracle'
  | 'amazon'
  | 'successfactors';

/**
 * Industry drives which seniority vocabulary applies. This is not cosmetic:
 * "Associate" is junior at a bank and mid-senior at a tech company, and
 * "Analyst" is entry-level in consulting but often mid-level in tech.
 */
export type Industry = 'tech' | 'fintech' | 'quant' | 'banking' | 'consulting';

export interface Company {
  name: string;
  ats: Ats;
  /** Greenhouse/Lever/Ashby board token, Workday tenant, Oracle host prefix. */
  token: string;
  industry: Industry;
  /** Workday only: the site path, e.g. "External_Career_Site". */
  site?: string;
  /**
   * Workday: the wdN host, e.g. "wd5". SuccessFactors legacy only: the
   * career{N}.successfactors.{eu,com,cn} host — its presence is what tells
   * the fetcher to use the legacy XML endpoint instead of Career Site
   * Builder's sitemal.xml (where `token` is the full hostname instead).
   */
  host?: string;
  /** Oracle only: the CX_xxxx site number. */
  siteNumber?: string;
  source?: 'curated' | 'discovered';
  /** ISO date of the first failure in the current streak; cleared on success. */
  failingSince?: string;
}

export interface RawJob {
  externalId: string;
  title: string;
  location: string;
  url: string;
  postedAt?: string;
  salary?: string;
  /** Description text, used for years-of-experience extraction. */
  text?: string;
}

export interface Job extends RawJob {
  /** Stable across runs: `${ats}:${token}:${externalId}`. */
  id: string;
  company: string;
  industry: Industry;
  minYears: number | null;
  maxYears: number | null;
  isIntern: boolean;
}

export type SeenState = Record<string, string>;
