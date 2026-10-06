import sys
import json
import logging
from typing import Dict, Any
import warnings
import re
from urllib.parse import urljoin
from functools import wraps

# Ignore the deprecation warning
warnings.filterwarnings('ignore')

from scrapling import Fetcher

logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(message)s")

def wait_for_dom(page):
    # The 0.4.15 browser engine waits for full load even with load_dom=False.
    # Careers pages may keep third-party assets open indefinitely. Use the
    # public page_setup hook to wait for DOM readiness and then job selectors.
    goto = page.goto
    wait = page.wait_for_load_state

    @wraps(goto)
    def goto_dom(url, **kwargs):
        return goto(url, **{**kwargs, "wait_until": "domcontentloaded"})

    @wraps(wait)
    def wait_dom(state="load", **kwargs):
        return wait("domcontentloaded" if state == "load" else state, **kwargs)

    page.goto = goto_dom
    page.wait_for_load_state = wait_dom

def job_rows(response, pattern, card_up):
    matcher = re.compile(pattern)
    rows = []
    seen = set()
    for anchor in response.css('a[href]'):
        href = urljoin(response.url, anchor.attrib['href'])
        if not matcher.search(href) or href in seen:
            continue
        own = anchor.get_all_text(separator=' ', strip=True)
        ancestors = anchor.xpath('ancestor::li[1]')
        card = ancestors[0] if ancestors else anchor.parent
        for _ in range(card_up):
            if card is None or card.parent is None:
                break
            parent = card.parent
            links = {urljoin(response.url, node.attrib['href']) for node in parent.css('a[href]')
                     if matcher.search(urljoin(response.url, node.attrib['href']))}
            if len(links) > 1:
                break
            card = parent
        heading = card.css('h2,h3,h4') if card is not None else []
        title = own if len(own) >= 6 else heading[0].get_all_text(separator=' ', strip=True) if heading else ''
        if len(title) < 4:
            continue
        seen.add(href)
        text = card.get_all_text(separator=' ', strip=True) if card is not None else own
        rows.append({'href': href, 'title': title, 'text': f'{own} {text}'[:1500]})
    return rows

def process_request(payload: Dict[str, Any]) -> Dict[str, Any]:
    # Validate contract
    if not isinstance(payload, dict):
        raise ValueError("Payload must be a JSON object")
    
    if payload.get("version") != 1:
        raise ValueError("Unsupported protocol version")
        
    url = payload.get("url")
    if not url or not isinstance(url, str) or not (url.startswith("http://") or url.startswith("https://")):
        raise ValueError("Invalid URL scheme")
        
    method = payload.get("method", "GET").upper()
    if method not in ("GET", "POST"):
        raise ValueError("Unsupported method")
        
    engine = payload.get("engine", "static")
    if engine not in ("static", "browser"):
        raise ValueError("Unsupported engine")
        
    headers = payload.get("headers") or {}
    body = payload.get("body")
    timeout = payload.get("timeout", 30)
    pattern = payload.get('job_link_pattern')
    card_up = payload.get('card_up', 0)
    if pattern is not None:
        if not isinstance(pattern, str) or len(pattern) > 1000 or not isinstance(card_up, int) or not 0 <= card_up <= 10:
            raise ValueError('Invalid job extraction options')
        re.compile(pattern)
    
    if engine == "static":
        fetcher = Fetcher()
        # Ensure we pass the headers exactly as requested
        if method == "GET":
            response = fetcher.get(url, headers=headers, timeout=timeout)
        else:
            if isinstance(body, dict):
                response = fetcher.post(url, headers=headers, json=body, timeout=timeout)
            elif isinstance(body, str):
                response = fetcher.post(url, headers=headers, data=body.encode('utf-8'), timeout=timeout)
            else:
                response = fetcher.post(url, headers=headers, data=body, timeout=timeout)

        # Build raw body string 
        raw_body = response.body
        try:
            text_body = raw_body.decode('utf-8')
            encoding = 'utf-8'
        except UnicodeDecodeError:
            text_body = raw_body.decode('latin-1', errors='replace')
            encoding = 'latin-1'
            
        return {
            "version": 1,
            "success": True,
            "status": response.status,
            "headers": dict(response.headers),
            "url": response.url,
            "body": text_body,
            "encoding": encoding,
            "engine": engine,
            "error": None
        }
    else:
        from scrapling import StealthyFetcher
        wait_selector = payload.get("wait_selector")
        solve_cloudflare = payload.get("solve_cloudflare", True)
        
        # The timeout is in milliseconds for StealthyFetcher
        timeout_ms = int(timeout * 1000)
        
        # Forward headers, use wait_selector for bounded site readiness
        fetch_kwargs = {
            "extra_headers": headers,
            "timeout": timeout_ms,
            "headless": True,
            "solve_cloudflare": solve_cloudflare,
            "google_search": False, # Do not override referer if provided
            "load_dom": False,
            "network_idle": False,
            "retries": 1,
            "page_setup": wait_for_dom,
        }
        
        if wait_selector:
            fetch_kwargs["wait_selector"] = wait_selector
            
        # StealthyFetcher.fetch is a class method
        response = StealthyFetcher.fetch(url, **fetch_kwargs)
        
        raw_body = response.body
        try:
            text_body = raw_body.decode('utf-8')
            encoding = 'utf-8'
        except UnicodeDecodeError:
            text_body = raw_body.decode('latin-1', errors='replace')
            encoding = 'latin-1'
            
        return {
            "version": 1,
            "success": True,
            "status": response.status,
            "headers": dict(response.headers),
            "url": response.url,
            "body": text_body,
            "encoding": encoding,
            "engine": engine,
            "error": None,
            "rows": job_rows(response, pattern, card_up) if pattern else None,
        }

def main():
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            raise ValueError("Empty body")
            
        payload = json.loads(raw_input)
        
        response = process_request(payload)
        
    except json.JSONDecodeError as e:
        logging.error(f"JSON decode error: {e}")
        response = {
            "version": 1,
            "success": False,
            "error": {"category": "protocol", "message": "Malformed JSON input"}
        }
    except ValueError as e:
        logging.error(f"Validation error: {e}")
        response = {
            "version": 1,
            "success": False,
            "error": {"category": "validation", "message": str(e)}
        }
    except Exception as e:
        logging.error(f"Internal error: {e}")
        response = {
            "version": 1,
            "success": False,
            "error": {"category": "internal", "message": str(e)}
        }
        
    sys.stdout.write(json.dumps(response))
    sys.stdout.flush()

if __name__ == "__main__":
    main()
