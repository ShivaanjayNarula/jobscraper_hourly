import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { list } from './darwinbox.js';
import { Company } from '../types.js';

const tmpDir = join(tmpdir(), `jobscraper_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);

describe('Darwinbox Fetcher', () => {
  let originalPath = process.env.PATH;

  before(() => {
    mkdirSync(tmpDir, { recursive: true });
    const curlBat = join(tmpDir, 'curl.bat');
    const fakeCurlJs = join(tmpDir, 'fake_curl.js');
    writeFileSync(curlBat, `@echo off\n"${process.execPath}" "${fakeCurlJs}" %*`);
    const fakePythonJs = join(tmpDir, 'fake_python.js');
    process.env.SCRAPLING_PYTHON_EXE = process.execPath;
    process.env.SCRAPLING_WORKER_PATH = fakePythonJs;
    process.env.PATH = `${tmpDir};${process.env.PATH}`;

    writeFileSync(fakePythonJs, `
      const fs = require('fs');
      if (process.env.FAKE_SCRAPLING_CODE) {
        eval(process.env.FAKE_SCRAPLING_CODE);
      }
    `);
    writeFileSync(fakeCurlJs, `
      if (process.env.FAKE_CURL_CODE) {
        eval(process.env.FAKE_CURL_CODE);
      }
    `);
  });

  after(() => {
    process.env.PATH = originalPath;
    delete process.env.SCRAPLING_PYTHON_EXE;
    delete process.env.SCRAPLING_WORKER_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setFakeResponses(scraplingCode: string, curlCode: string) {
    process.env.FAKE_SCRAPLING_CODE = scraplingCode;
    process.env.FAKE_CURL_CODE = curlCode;
  }

  const baseCompany: Company = { name: 'Test', ats: 'darwinbox', token: 'test', industry: 'tech' };

  test('v1 empty companyId', async () => {
    setFakeResponses(`
      const fs = require('fs');
      const payload = JSON.parse(fs.readFileSync(0, 'utf-8'));
      const bodyParams = JSON.parse(payload.body);
      const ok = payload.url.includes('companyId=') && !payload.url.includes('companyId=something');
      const bodyOk = bodyParams.companyId === '';
      const response = {
        version: 1, success: true, url: payload.url,
        body: JSON.stringify({ status: 'success', data: ok && bodyOk && bodyParams.page === 1 ? [{id: 'job1', designation: 'Engineer'}] : [] })
      };
      process.stdout.write(JSON.stringify(response));
    `, `process.stdout.write('{"status":"success","data":[]}');`);
    const jobs = await list(baseCompany);
    assert.strictEqual(jobs.length, 1);
  });

  test('v2 companyId body/query', async () => {
    setFakeResponses(`
      const fs = require('fs');
      const payload = JSON.parse(fs.readFileSync(0, 'utf-8'));
      const bodyParams = JSON.parse(payload.body);
      const bodyOk = bodyParams.companyId === 'site123';
      const urlOk = payload.url.includes('companyId=site123');
      const response = {
        version: 1, success: true, url: payload.url,
        body: JSON.stringify({ status: 'success', data: bodyOk && urlOk && bodyParams.page === 1 ? [{id: 'job2'}] : [] })
      };
      process.stdout.write(JSON.stringify(response));
    `, ``);
    const jobs = await list({ ...baseCompany, site: 'site123' });
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0]!.url.includes('site123'), true);
  });

  test('multi-page total', async () => {
    setFakeResponses(`
      const fs = require('fs');
      const payload = JSON.parse(fs.readFileSync(0, 'utf-8'));
      const page = JSON.parse(payload.body).page;
      let data = [];
      if (page === 1) data = Array(50).fill({id: 'j1'});
      if (page === 2) data = Array(20).fill({id: 'j2'});
      const response = {
        version: 1, success: true, url: payload.url,
        body: JSON.stringify({ status: 'success', job_counts: 70, data })
      };
      process.stdout.write(JSON.stringify(response));
    `, ``);
    const jobs = await list(baseCompany);
    assert.strictEqual(jobs.length, 70);
  });

  test('empty terminal page', async () => {
    setFakeResponses(`
      const fs = require('fs');
      const payload = JSON.parse(fs.readFileSync(0, 'utf-8'));
      const page = JSON.parse(payload.body).page;
      const data = page === 1 ? [{id: 'j1'}] : [];
      const response = {
        version: 1, success: true, url: payload.url,
        body: JSON.stringify({ status: 'success', job_counts: 100, data })
      };
      process.stdout.write(JSON.stringify(response));
    `, ``);
    const jobs = await list(baseCompany);
    assert.strictEqual(jobs.length, 1);
  });

  test('malformed data', async () => {
    setFakeResponses(`
      const fs = require('fs');
      const payload = JSON.parse(fs.readFileSync(0, 'utf-8'));
      const response = {
        version: 1, success: true, url: payload.url,
        body: JSON.stringify({ status: 'success', data: null }) // validation fails
      };
      process.stdout.write(JSON.stringify(response));
    `, `
      process.stdout.write(JSON.stringify({ status: "success", data: [{id: "j1"}] }));
    `);
    const jobs = await list(baseCompany);
    assert.strictEqual(jobs.length, 1); // Note: Since curl is static here, it will always return 1 job, which creates an infinite loop if page is ignored, but list checks for page logic so let's make curl check page via env var instead of argv
  });

  test('invalid epoch/string dates', async () => {
    setFakeResponses(`
      const fs = require('fs');
      const payload = JSON.parse(fs.readFileSync(0, 'utf-8'));
      const page = JSON.parse(payload.body).page;
      const response = {
        version: 1, success: true, url: payload.url,
        body: JSON.stringify({ status: 'success', data: page === 1 ? [
          {id: 'j1', created_on: 'not a date'},
          {id: 'j2', created_on: -9223372036854776000}
        ] : [] })
      };
      process.stdout.write(JSON.stringify(response));
    `, ``);
    const jobs = await list(baseCompany);
    assert.strictEqual(jobs.length, 2);
    assert.strictEqual(jobs[0]!.postedAt, undefined);
    assert.strictEqual(jobs[1]!.postedAt, undefined);
  });

  test('fallback on first page', async () => {
    setFakeResponses(`
      process.stdout.write(JSON.stringify({version:1, success:false, error:{message:'fail', category:'network'}}));
    `, `
      const args = process.argv.slice(2);
      const dataStr = args.find(a => a.startsWith('{"companyId"'));
      const page = dataStr ? JSON.parse(dataStr).page : 1;
      process.stdout.write(JSON.stringify({ status: "success", data: page === 1 ? [{id: "j1"}] : [] }));
    `);
    const jobs = await list(baseCompany);
    assert.strictEqual(jobs.length, 1);
  });

  test('failure on later page', async () => {
    // page 1 success via scrapling, page 2 fails via scrapling and falls back to curl
    setFakeResponses(`
      const fs = require('fs');
      const payload = JSON.parse(fs.readFileSync(0, 'utf-8'));
      const page = JSON.parse(payload.body).page;
      if (page === 1) {
        process.stdout.write(JSON.stringify({version:1, success:true, body: JSON.stringify({ status: 'success', data: Array(50).fill({id:'j1'}), job_counts: 51 })}));
      } else {
        process.stdout.write(JSON.stringify({version:1, success:false, error:{message:'fail', category:'network'}}));
      }
    `, `
      const args = process.argv.slice(2);
      const dataStr = args.find(a => a.startsWith('{"companyId"'));
      const page = dataStr ? JSON.parse(dataStr).page : 1;
      if (page === 2) {
        process.stdout.write('{"status":"success","data":[{"id":"j2"}]}');
      } else {
        process.stdout.write('{"status":"success","data":[]}');
      }
    `);
    const jobs = await list(baseCompany);
    assert.strictEqual(jobs.length, 51);
  });

  test('both engines fail', async () => {
    process.env.FAKE_SCRAPLING_CODE = `
      process.stdout.write(JSON.stringify({version:1, success:false, error:{message:'fail1', category:'network'}}));
    `;
    process.env.FAKE_CURL_CODE = `
      throw new Error('fail2');
    `;
    try {
      await list(baseCompany);
      assert.fail("should have thrown");
    } catch(err) {
      if (!String(err).includes('fail2')) {
        console.log("ACTUAL ERROR IN TEST:", err);
      }
      assert.match(String(err), /fail2/);
    }
  });

  test('legitimate zero jobs', async () => {
    setFakeResponses(`
      process.stdout.write(JSON.stringify({version:1, success:true, body: JSON.stringify({ status: 'success', data: [] })}));
    `, `throw new Error('should not fallback');`);
    const jobs = await list(baseCompany);
    assert.strictEqual(jobs.length, 0);
  });
});
