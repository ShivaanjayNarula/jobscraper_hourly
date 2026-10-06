import unittest
from unittest.mock import patch
from types import SimpleNamespace
from scrapling_worker import process_request
from scrapling.parser import Selector


class BrowserReadinessTest(unittest.TestCase):
    def test_browser_rows_do_not_inherit_neighbour_location(self):
        response = Selector(b'<html><body><ul><li><a href="/en/jobs/123456/">Engineer Bangalore</a><span>India</span></li><li><a href="/en/jobs/234567/">General Manager</a><span>South Africa</span></li></ul></body></html>', url='https://jobs.example/')
        response.status = 200
        response.headers = {}
        with patch('scrapling.StealthyFetcher.fetch', return_value=response):
            result = process_request({'version': 1, 'url': response.url, 'engine': 'browser', 'job_link_pattern': r'/en/jobs/\d+', 'card_up': 4})
        self.assertEqual(len(result.get('rows', [])), 2)
        self.assertEqual(result['rows'][0]['href'], 'https://jobs.example/en/jobs/123456/')
        self.assertIn('South Africa', result['rows'][1]['text'])
        self.assertNotIn('India', result['rows'][1]['text'])

    def test_browser_waits_for_requested_cards_without_full_load_or_nested_retries(self):
        response = SimpleNamespace(body=b'<html>jobs</html>', status=200, headers={}, url='https://jobs.example/')
        with patch('scrapling.StealthyFetcher.fetch', return_value=response) as fetch:
            result = process_request({'version': 1, 'url': response.url, 'engine': 'browser', 'timeout': 20, 'wait_selector': 'a[href*="/jobs/"]'})
        self.assertTrue(result['success'])
        options = fetch.call_args.kwargs
        self.assertFalse(options.get('load_dom', True))
        self.assertEqual(options.get('retries'), 1)
        self.assertEqual(options['wait_selector'], 'a[href*="/jobs/"]')
        page = SimpleNamespace(goto=lambda url, **kwargs: kwargs, wait_for_load_state=lambda state='load', **kwargs: state)
        options['page_setup'](page)
        self.assertEqual(page.goto(response.url)['wait_until'], 'domcontentloaded')
        self.assertEqual(page.wait_for_load_state('load'), 'domcontentloaded')


if __name__ == '__main__':
    unittest.main()
