import type { Ats, Company, RawJob } from '../types.js';
import * as greenhouse from './greenhouse.js';
import * as lever from './lever.js';
import * as ashby from './ashby.js';
import * as smartrecruiters from './smartrecruiters.js';
import * as workday from './workday.js';
import * as oracle from './oracle.js';
import * as amazon from './amazon.js';
import * as atlassian from './atlassian.js';
import * as phenom from './phenom.js';
import * as eightfold from './eightfold.js';
import * as darwinbox from './darwinbox.js';
import * as turbohire from './turbohire.js';
import * as rendered from './rendered.js';
import * as successfactors from './successfactors.js';
import * as trakstar from './trakstar.js';
import * as icims from './icims.js';
import * as workable from './workable.js';
import * as zohorecruit from './zohorecruit.js';
import * as keka from './keka.js';
import * as freshteam from './freshteam.js';
import * as recruiterflow from './recruiterflow.js';
import * as greythr from './greythr.js';
import * as peoplestrong from './peoplestrong.js';
import * as pyjamahr from './pyjamahr.js';
import * as zappyhire from './zappyhire.js';
import * as zimyo from './zimyo.js';
import * as recruitee from './recruitee.js';

export interface Fetcher {
  list(company: Company): Promise<RawJob[]>;
  /** Only defined for ATSes whose list view omits the description. */
  enrich?(company: Company, job: RawJob): Promise<string | undefined>;
}

export const FETCHERS: Record<Ats, Fetcher> = {
  greenhouse,
  lever,
  ashby,
  smartrecruiters,
  workday,
  oracle,
  amazon,
  atlassian,
  phenom,
  eightfold,
  darwinbox,
  turbohire,
  rendered,
  successfactors,
  trakstar,
  icims,
  workable,
  zohorecruit,
  keka,
  freshteam,
  recruiterflow,
  greythr,
  peoplestrong,
  pyjamahr,
  zappyhire,
  zimyo,
  recruitee,
};
