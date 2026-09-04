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
  | 'successfactors'
  | 'trakstar'
  | 'icims'
  | 'workable'
  | 'zohorecruit'
  | 'keka'
  | 'freshteam'
  | 'recruiterflow'
  | 'greythr'
  | 'peoplestrong'
  | 'pyjamahr'
  | 'zappyhire'
  | 'zimyo'
  | 'recruitee';

/**
 * Industry drives which seniority vocabulary applies. This is not cosmetic:
 * "Associate" is junior at a bank and mid-senior at a tech company, and
 * "Analyst" is entry-level in consulting but often mid-level in tech.
 */
export type Industry = 'tech' | 'fintech' | 'quant' | 'banking' | 'consulting';

export interface Company {
  name: string;
  ats: Ats;
  /**
   * Greenhouse/Lever/Ashby/Workable/Trakstar/Keka/Freshteam/Recruiterflow
   * board token or tenant subdomain, Workday tenant, Oracle host prefix.
   * iCIMS and Zoho Recruit hold the full board URL/host instead, since
   * neither has one predictable subdomain pattern.
   */
  token: string;
  industry: Industry;
  /** Workday: the site path, e.g. "External_Career_Site". Keka: the portalName (usually omitted, defaults to "default"). */
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
  /**
   * Legacy. The live value now lives in `state/board-state.json`; this is only
   * still read to seed that file the first time, or after a cache eviction.
   * `saveCompanies` strips it on write — see `BoardState` below.
   */
  failingSince?: string;
  /**
   * ISO date this board last returned at least one India/remote role. Its
   * presence is what makes a board "hot" — polled every run. Boards that have
   * never shown one are swept on rotation instead (see `selectBoards`), which
   * is what lets the corpus hold tens of thousands of boards without the run
   * time growing with it.
   */
  lastIndiaAt?: string;
  /** Legacy, same as `failingSince` above — the live value is in `BoardState`. */
  lastPolledAt?: string;
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
  /** Name of the person who created this requisition, when the ATS's own
   *  public API exposes it (currently only SmartRecruiters does, via its
   *  `creator` field). Job-specific, not company-wide — a much stronger
   *  outreach signal than "some engineer at this company" once combined
   *  with a known domain/pattern. */
  postedBy?: string;
}

export interface Job extends RawJob {
  /** Stable across runs: `${ats}:${token}:${externalId}`. */
  id: string;
  company: string;
  industry: Industry;
  minYears: number | null;
  maxYears: number | null;
  isIntern: boolean;
  /** Normalized ₹ LPA from the posting's own salary field or description. */
  salaryMin?: number;
  salaryMax?: number;
  workMode?: 'remote' | 'hybrid' | 'onsite' | null;
  visa?: boolean;
  /** Was live here before, vanished, and came back — a re-opened requisition. */
  isRepost?: boolean;
}

export type SeenState = Record<string, string>;

/**
 * Per-board polling bookkeeping, keyed by `boardKey` from board-url.ts.
 *
 * These two fields used to live on the `Company` row, which meant every run
 * rewrote up to `BOARDS_PER_RUN` of them in `companies.json` — a file that is
 * committed on almost every run. 448 of the repo's first 547 commits touched
 * it. Splitting the volatile half out into the Actions cache, exactly as
 * `seen.json` already does, leaves `companies.json` changing only when a board
 * is added, dropped, or first goes hot.
 *
 * Losing this file is safe by construction: every board then reads as
 * never-polled, which `selectBoards` already sorts first (a clean full sweep),
 * and a reset `failingSince` only ever delays an eviction, never causes one.
 */
export interface BoardStatus {
  /** ISO date this board was last polled at all. Drives the cold rotation. */
  lastPolledAt?: string;
  /** ISO date of the first failure in the current streak; cleared on success. */
  failingSince?: string;
}

export type BoardState = Record<string, BoardStatus>;

/**
 * Repost tracking. `last` is the last run the id was live; `gone` is set when
 * it stopped being live and cleared when it returns — an id that alerts while
 * `gone` is set is a reopened requisition, one of the strongest urgency
 * signals there is (see PHASES.md Phase A).
 */
export interface RepostEntry {
  last: string;
  gone?: string;
}
export type RepostState = Record<string, RepostEntry>;
