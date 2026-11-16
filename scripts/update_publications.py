#!/usr/bin/env python3
"""
Keep the SAFEE Group publication list up to date.

Sources (all optional, used when available):
  * Google Scholar profile, read through SerpApi (needs the SERPAPI_KEY secret).
    Gives the list of papers and citation counts.
  * ORCID public API (no key). Gives papers with DOIs.
  * Crossref (no key). Fills in full author lists, journal, volume and pages from a DOI.

What it does:
  1. Loads data/publications.json (the list shown on the site) and
     data/publications-config.json (your IDs, selected papers, exclusions).
  2. Fetches the sources, matches papers by DOI or by title, adds new ones,
     and refreshes citation counts. Text you have edited by hand is kept.
  3. Re-renders the marked sections of publications.html and the stats on index.html.

Usage:
  python scripts/update_publications.py            # fetch sources, update data, render pages
  python scripts/update_publications.py --offline  # only re-render pages from the JSON
  python scripts/update_publications.py --refresh-metadata
        # also re-pull Crossref metadata for existing papers that have a DOI
        # (skips papers marked "locked": true)
"""

import argparse
import datetime as dt
import difflib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data', 'publications.json')
CONFIG = os.path.join(ROOT, 'data', 'publications-config.json')
PAGES = {'publications': os.path.join(ROOT, 'publications.html'), 'index': os.path.join(ROOT, 'index.html')}
USER_AGENT = 'SAFEE-publications-updater/1.0 (+https://koundinyantbn.github.io)'

log_lines = []
def log(msg):
    print(msg)
    log_lines.append(msg)


# --------------------------------------------------------------------------- helpers
def http_get_json(url, headers=None, tries=3):
    """GET a URL and parse JSON. Returns None on failure (the run carries on)."""
    h = {'User-Agent': USER_AGENT, 'Accept': 'application/json'}
    h.update(headers or {})
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(4 * (attempt + 1))
                continue
            log(f'  ! HTTP {e.code} for {redact(url)}')
            return None
        except Exception as e:  # network errors, bad JSON
            if attempt < tries - 1:
                time.sleep(3)
                continue
            log(f'  ! {type(e).__name__} for {redact(url)}: {e}')
            return None


def redact(url):
    return re.sub(r'(api_key=)[^&]+', r'\1***', url)


def strip_tags(s):
    return re.sub(r'<[^>]+>', '', s or '').strip()


def norm_title(t):
    t = html.unescape(strip_tags(t or '')).lower()
    t = t.replace('–', '-').replace('—', '-')
    return re.sub(r'[^a-z0-9]+', '', t)


def title_similarity(a, b):
    a, b = norm_title(a), norm_title(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def norm_doi(d):
    if not d:
        return None
    d = d.strip()
    d = re.sub(r'^(https?://(dx\.)?doi\.org/|doi:\s*)', '', d, flags=re.I)
    return d.lower() or None


def today():
    return dt.date.today().isoformat()


# --------------------------------------------------------------------------- data store
def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write('\n')


class Store:
    def __init__(self, data, config):
        self.data = data
        self.items = data.setdefault('publications', [])
        self.config = config
        self.excluded_dois = {norm_doi(x) for x in config.get('exclude', {}).get('dois', [])}
        self.excluded_titles = [norm_title(x) for x in config.get('exclude', {}).get('titles', [])]
        self.added = []
        self.changed = 0

    def is_excluded(self, title, doi):
        if doi and norm_doi(doi) in self.excluded_dois:
            return True
        nt = norm_title(title)
        return any(x and (x in nt or difflib.SequenceMatcher(None, x, nt).ratio() > 0.92) for x in self.excluded_titles)

    def find(self, title=None, doi=None, scholar_id=None):
        d = norm_doi(doi)
        if d:
            for it in self.items:
                if norm_doi(it.get('doi')) == d:
                    return it
        if scholar_id:
            for it in self.items:
                if it.get('scholar_id') == scholar_id:
                    return it
        if title:
            best, score = None, 0.0
            for it in self.items:
                s = title_similarity(title, it.get('title'))
                if s > score:
                    best, score = it, s
            if score >= 0.9:
                return best
        return None

    def add(self, rec):
        rec.setdefault('added', today())
        self.items.append(rec)
        self.added.append(rec)
        log(f'  + added: {rec["title"][:90]} ({rec.get("year")})')

    def set(self, it, key, value):
        if value is None or value == '' or it.get(key) == value:
            return
        it[key] = value
        self.changed += 1


# --------------------------------------------------------------------------- Crossref
CROSSREF_TYPES = {
    'journal-article': 'journal',
    'proceedings-article': 'conference',
    'book-chapter': 'journal',
}


def is_me(given, family, pattern):
    full = f'{given or ""} {family or ""}'
    return re.search(pattern, full, re.I) is not None


def initials(given):
    """'Ravi Sankar' -> 'R. S.'; run-together capitals such as 'TT' or 'SVSN' -> 'T. T.', 'S. V. S. N.'."""
    out = []
    for part in re.split(r'[\s.\-]+', given or ''):
        if not part:
            continue
        if part.isupper() and 2 <= len(part) <= 4:
            out.extend(ch + '.' for ch in part)
        else:
            out.append(part[0].upper() + '.')
    return ' '.join(out)


def tidy_name(given, family):
    """Fix two common Crossref quirks: an initial stored as the surname ('Kamaraj', 'M.'),
    and a surname with a trailing initial ('Chandru', 'Fernando D')."""
    given, family = (given or '').strip(), (family or '').strip()
    if re.fullmatch(r'[A-Z]\.?', family) and given:
        return family, given                      # swap: 'M. Kamaraj'
    m = re.fullmatch(r'(.+?)\s+([A-Z])\.?', family)
    if m and given and ' ' not in given:
        return f'{m.group(1)} {m.group(2)}', given   # 'Chandru, F. D.'
    return given, family


def format_authors(authors, me_pattern, me_display):
    names = []
    for a in authors:
        given, family = tidy_name(a.get('given', ''), a.get('family', ''))
        if not family and a.get('name'):
            names.append(a['name'])
            continue
        if is_me(given, family, me_pattern):
            if me_display not in names:
                names.append(me_display)
        else:
            ini = initials(given)
            names.append(f'{family}, {ini}' if ini else family)
    if len(names) == 2:
        return f'{names[0]} and {names[1]}'
    if len(names) > 2:
        return ', '.join(names[:-1]) + ', and ' + names[-1]
    return names[0] if names else ''


def crossref_record(msg, cfg):
    """Turn a Crossref work into a publication record."""
    title = strip_tags(html.unescape((msg.get('title') or [''])[0]))
    venue = strip_tags(html.unescape((msg.get('container-title') or [''])[0]))
    parts = None
    for k in ('published-print', 'published-online', 'issued', 'created'):
        dp = (msg.get(k) or {}).get('date-parts') or []
        if dp and dp[0] and dp[0][0]:
            parts = dp[0]
            break
    year = parts[0] if parts else None
    date = '-'.join(f'{p:02d}' if i else str(p) for i, p in enumerate(parts)) if parts else None
    vol, issue = msg.get('volume'), msg.get('issue')
    page = msg.get('article-number') or msg.get('page')
    details = []
    if vol:
        details.append(f'{vol}({issue})' if issue else vol)
    if page:
        details.append(page)
    doi = msg.get('DOI')
    return {
        'title': title,
        'authors': format_authors(msg.get('author') or [], cfg['author_pattern'], cfg['author_display']),
        'venue': venue,
        'details': ', '.join(details),
        'year': year,
        'date': date,
        'doi': doi,
        'url': f'https://doi.org/{doi}' if doi else msg.get('URL'),
        'type': CROSSREF_TYPES.get(msg.get('type'), 'other'),
    }


def crossref_by_doi(doi, cfg):
    q = urllib.parse.quote(doi, safe='')
    mail = cfg.get('crossref_mailto')
    url = f'https://api.crossref.org/works/{q}' + (f'?mailto={urllib.parse.quote(mail)}' if mail else '')
    res = http_get_json(url)
    return crossref_record(res['message'], cfg) if res and res.get('message') else None


def crossref_by_title(title, year, cfg):
    params = {'query.bibliographic': title, 'rows': '3'}
    if cfg.get('crossref_mailto'):
        params['mailto'] = cfg['crossref_mailto']
    res = http_get_json('https://api.crossref.org/works?' + urllib.parse.urlencode(params))
    for msg in ((res or {}).get('message') or {}).get('items') or []:
        rec = crossref_record(msg, cfg)
        if title_similarity(title, rec['title']) >= 0.93 and (not year or not rec['year'] or abs(int(rec['year']) - int(year)) <= 1):
            return rec
    return None


# --------------------------------------------------------------------------- Google Scholar via SerpApi
def fetch_scholar(cfg, key):
    """Return (articles, metrics) from the Google Scholar profile, or (None, None)."""
    author_id = cfg.get('scholar_user_id')
    if not author_id:
        return None, None
    articles, metrics, start = [], None, 0
    while True:
        params = {'engine': 'google_scholar_author', 'author_id': author_id, 'hl': 'en',
                  'sort': 'pubdate', 'num': '100', 'start': str(start), 'api_key': key}
        res = http_get_json('https://serpapi.com/search.json?' + urllib.parse.urlencode(params))
        if not res or res.get('error'):
            if res and res.get('error'):
                log(f'  ! SerpApi: {res["error"]}')
            return (articles or None), metrics
        if metrics is None:
            metrics = parse_scholar_metrics(res.get('cited_by') or {})
        page = res.get('articles') or []
        articles.extend(page)
        if len(page) < 100 or start >= 900:
            break
        start += 100
    return articles, metrics


def parse_scholar_metrics(cited_by):
    out = {}
    for row in cited_by.get('table') or []:
        for k, v in row.items():
            if not isinstance(v, dict):
                continue
            k = k.lower()
            name = 'citations' if 'citation' in k else 'i10_index' if 'i10' in k else 'h_index' if 'h' in k else None
            if name and 'all' in v:
                try:
                    out[name] = int(v['all'])
                except (TypeError, ValueError):
                    pass
    return out or None


CONF_HINT = re.compile(r'proceedings|conference|symposium|procedia|congress|workshop', re.I)


def scholar_fallback_record(a, cfg):
    pub = a.get('publication') or ''
    year = a.get('year')
    venue = re.sub(r',?\s*\d{4}\s*$', '', pub).strip()
    m = re.match(r'^(.*?)(\s+\d.*)?$', venue)
    return {
        'title': strip_tags(a.get('title', '')),
        'authors': re.sub(cfg['author_pattern_html'], cfg['author_display'], a.get('authors') or '', flags=re.I),
        'venue': (m.group(1) if m else venue).strip(' ,'),
        'details': (m.group(2) or '').strip(' ,') if m else '',
        'year': int(year) if str(year or '').isdigit() else None,
        'doi': None,
        'url': a.get('link'),
        'type': 'conference' if CONF_HINT.search(pub) else 'journal',
    }


def merge_scholar(store, articles, cfg):
    best = {}  # one paper can appear twice on Scholar (e.g. preprint and journal version)
    for a in articles:
        title = strip_tags(a.get('title', ''))
        sid = a.get('citation_id')
        cites = ((a.get('cited_by') or {}).get('value'))
        if not title or store.is_excluded(title, None):
            continue
        it = store.find(title=title, scholar_id=sid)
        if not it:
            rec = crossref_by_title(title, a.get('year'), cfg)
            if rec and store.is_excluded(rec['title'], rec['doi']):
                continue
            if rec:
                it = store.find(title=rec['title'], doi=rec['doi'])
            if not it:
                rec = rec or scholar_fallback_record(a, cfg)
                if rec['type'] == 'other' or not rec.get('year'):
                    log(f'  - skipped (not a journal or conference paper): {title[:90]}')
                    continue
                rec['sources'] = ['scholar'] + (['crossref'] if rec.get('doi') else [])
                store.add(rec)
                it = rec
        cites = cites if isinstance(cites, int) else 0
        if cites >= best.get(id(it), -1):
            best[id(it)] = cites
            store.set(it, 'scholar_id', sid)
            if cites:
                store.set(it, 'citations', cites)
        if 'scholar' not in it.setdefault('sources', []):
            it['sources'].append('scholar')


# --------------------------------------------------------------------------- ORCID
ORCID_TYPES = {'journal-article': 'journal', 'conference-paper': 'conference', 'book-chapter': 'journal'}


def fetch_orcid(cfg):
    orcid = cfg.get('orcid')
    if not orcid:
        return None
    res = http_get_json(f'https://pub.orcid.org/v3.0/{orcid}/works')
    if not res:
        return None
    works = []
    for g in res.get('group') or []:
        summaries = g.get('work-summary') or []
        if not summaries:
            continue
        s = summaries[0]
        ids = ((s.get('external-ids') or {}).get('external-id') or []) + \
              ((g.get('external-ids') or {}).get('external-id') or [])
        doi = next((x.get('external-id-value') for x in ids if (x.get('external-id-type') or '').lower() == 'doi'), None)
        year = (((s.get('publication-date') or {}).get('year') or {}).get('value'))
        works.append({
            'title': (((s.get('title') or {}).get('title') or {}).get('value')) or '',
            'type': s.get('type'),
            'year': int(year) if year and year.isdigit() else None,
            'venue': ((s.get('journal-title') or {}).get('value')) or '',
            'doi': norm_doi(doi),
            'url': ((s.get('url') or {}).get('value')),
        })
    return works


def merge_orcid(store, works, cfg):
    for w in works:
        if not w['title'] or store.is_excluded(w['title'], w['doi']):
            continue
        it = store.find(title=w['title'], doi=w['doi'])
        if not it:
            rec = crossref_by_doi(w['doi'], cfg) if w['doi'] else None
            if rec and store.is_excluded(rec['title'], rec['doi']):
                continue
            if rec:
                it = store.find(title=rec['title'], doi=rec['doi'])
        if not it:
            if not rec:
                t = ORCID_TYPES.get(w['type'], 'other')
                rec = {'title': w['title'], 'authors': '', 'venue': w['venue'], 'details': '', 'year': w['year'],
                       'doi': w['doi'], 'url': f'https://doi.org/{w["doi"]}' if w['doi'] else w['url'], 'type': t}
            if rec['type'] == 'other' or not rec.get('year'):
                log(f'  - skipped (not a journal or conference paper): {w["title"][:90]}')
                continue
            rec['sources'] = ['orcid'] + (['crossref'] if rec.get('doi') else [])
            store.add(rec)
            continue
        if w['doi'] and not it.get('doi'):
            store.set(it, 'doi', w['doi'])
            store.set(it, 'url', f'https://doi.org/{w["doi"]}')
        if 'orcid' not in it.setdefault('sources', []):
            it['sources'].append('orcid')


def refresh_metadata(store, cfg):
    for it in store.items:
        if it.get('locked') or not it.get('doi'):
            continue
        rec = crossref_by_doi(it['doi'], cfg)
        if not rec:
            continue
        for k in ('title', 'authors', 'venue', 'details', 'year', 'date'):
            store.set(it, k, rec.get(k))


# --------------------------------------------------------------------------- rendering
def sort_key(p):
    # newest year first; within a year, dated papers (newest first), then the existing order
    d = p.get('date') or ''
    n = int((d.replace('-', '') + '0101')[:8]) if re.match(r'^\d{4}', d) else 0
    return (-(p.get('year') or 0), -n, p.get('order', 9999))


def esc(s):
    return html.escape(s or '', quote=True)


def render_authors(p, cfg):
    text = esc(p.get('authors'))
    return re.sub(cfg['author_pattern_html'], lambda m: f'<strong>{m.group(0)}</strong>', text, flags=re.I)


COVERS_FILE = os.path.join(ROOT, 'data', 'journal-covers.json')
_covers = None


def norm_venue(v):
    v = html.unescape(v or '').lower().replace('&', 'and')
    return re.sub(r'[^a-z0-9]+', ' ', v).strip()


def cover_for(venue):
    """Find the cover entry for a journal name: exact match first, then the longest prefix match."""
    global _covers
    if _covers is None:
        _covers = load_json(COVERS_FILE, {}).get('journals', [])
    v = norm_venue(venue)
    if not v:
        return None
    exact = [c for c in _covers if norm_venue(c.get('match')) == v]
    if exact:
        return exact[0]
    pref = [c for c in _covers if v.startswith(norm_venue(c.get('match')) + ' ')]
    return max(pref, key=lambda c: len(c['match'])) if pref else None


def short_label(venue):
    words = [w for w in re.split(r'[\s:]+', venue or '') if w and w.lower() not in ('of', 'and', 'the', '&', 'a', 'on', 'in')]
    return ' '.join(w[:5] + ('.' if len(w) > 5 else '') for w in words[:4]) or 'Journal'


COVERS_DIR = os.path.join(ROOT, 'covers')


def cover_slug(match):
    return re.sub(r'[^a-z0-9]+', '-', norm_venue(match)).strip('-')


def local_cover(c):
    """Path of a downloaded copy of this journal's cover, if the repository has one."""
    if not c or not c.get('match'):
        return None
    for ext in ('jpg', 'png', 'gif', 'webp'):
        rel = f'covers/{cover_slug(c["match"])}.{ext}'
        if os.path.exists(os.path.join(ROOT, rel)):
            return rel
    return None


def fetch_covers(items):
    """Download the covers of journals in the list, so the site serves its own copies."""
    os.makedirs(COVERS_DIR, exist_ok=True)
    seen = set()
    for p in items:
        c = cover_for(p.get('venue'))
        if not c or not str(c.get('cover', '')).startswith('http') or c['match'] in seen or local_cover(c):
            continue
        seen.add(c['match'])
        try:
            req = urllib.request.Request(c['cover'], headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as r:
                kind = r.headers.get('Content-Type', '')
                data = r.read()
            if not kind.startswith('image/') or len(data) < 2000:
                log(f'  ! cover for {c["match"]} was not an image, skipped')
                continue
            ext = 'png' if 'png' in kind else 'gif' if 'gif' in kind else 'webp' if 'webp' in kind else 'jpg'
            with open(os.path.join(COVERS_DIR, f'{cover_slug(c["match"])}.{ext}'), 'wb') as f:
                f.write(data)
            log(f'  saved cover: {c["match"]}')
        except Exception as e:
            log(f'  ! could not download the cover for {c["match"]}: {type(e).__name__}')


def render_cover(p, link):
    venue = p.get('venue') or ''
    c = cover_for(venue) or {}
    label = esc(c.get('label') or short_label(venue))
    color = c.get('color') or '#6b7280'
    img = ''
    src = local_cover(c) or c.get('cover')
    if src:
        img = (f'<img src="{esc(src)}" alt="" loading="lazy" decoding="async" '
               f'referrerpolicy="no-referrer" onerror="this.remove()">')
    tag = 'a' if link else 'span'
    href = f' href="{link}" target="_blank" rel="noopener noreferrer"' if link else ''
    return (f'        <{tag} class="pub-cover"{href} title="{esc(venue)}" aria-label="{esc(venue)}" style="--cover:{esc(color)}">'
            f'<span class="pub-cover-label">{label}</span>{img}</{tag}>')


def render_pub(p, cfg):
    """One publication card: text on the left, the journal cover on the right."""
    venue = esc(p.get('venue'))
    details = esc(p.get('details'))
    journal = ', '.join(x for x in (venue, details) if x)
    if p.get('year'):
        journal += f' ({p["year"]})'
    link = f'https://doi.org/{esc(p["doi"])}' if p.get('doi') else esc(p.get('url') or '')
    lines = [
        '      <div class="pub-row">',
        '        <div class="pub-main">',
        f'          <div class="pub-title">{esc(p["title"])}</div>',
        f'          <div class="pub-authors">{render_authors(p, cfg)}</div>',
        f'          <div class="pub-journal">{journal}</div>',
    ]
    label = f'DOI: {esc(p["doi"])}' if p.get('doi') else 'Link'
    cites = f'<span class="pub-cites">Cited by {p["citations"]}</span>' if p.get('citations') else ''
    if link or cites:
        a = f'<a href="{link}" target="_blank" rel="noopener noreferrer">{label}</a>' if link else ''
        lines.append(f'          <div class="pub-doi"><span>{a}</span>{cites}</div>')
    lines.append('        </div>')
    lines.append(render_cover(p, link))
    lines.append('      </div>')
    return '\n'.join(lines)


def selected_items(items, cfg):
    out = []
    for key in cfg.get('selected', []):
        it = next((p for p in items if (norm_doi(key) and norm_doi(p.get('doi')) == norm_doi(key)) or
                   (not key.startswith('10.') and title_similarity(key, p['title']) >= 0.9)), None)
        if it:
            out.append(it)
        else:
            log(f'  ! selected paper not found in the list: {key}')
    return out


def render_pages(data, cfg):
    items = data['publications']
    journal = sorted([p for p in items if p.get('type') == 'journal'], key=sort_key)
    conf = sorted([p for p in items if p.get('type') == 'conference'], key=sort_key)
    sel = selected_items(items, cfg)

    def block(lst):
        if not lst:
            return '\n      <p class="role-desc">Nothing listed yet.</p>\n'
        return '\n' + '\n\n'.join(render_pub(p, cfg) for p in lst) + '\n'

    metrics = data.get('scholar_metrics') or {}
    checked = data.get('last_checked')
    parts = []
    if metrics.get('citations'):
        m = f'Cited {metrics["citations"]:,} times'
        if metrics.get('h_index'):
            m += f', h-index {metrics["h_index"]}'
        parts.append(m + ' on Google Scholar.')
    if checked:
        when = dt.date.fromisoformat(checked)
        srcs = ' and '.join(data.get('last_sources') or []) or 'Google Scholar and ORCID'
        parts.append(f'This list updates automatically from {srcs}. Last checked {when.day} {when.strftime("%B %Y")}.')
    else:
        parts.append('This list updates automatically from Google Scholar and ORCID every week.')

    first_year = min((p['year'] for p in journal if p.get('year')), default='')
    cites = ''
    if metrics.get('citations'):
        cites = f'\n            <div class="stat"><b>{metrics["citations"]:,}</b><span>Citations (Google Scholar)</span></div>'
    pages = {
        'publications': {
            'selected-pubs': block(sel),
            'all-pubs': block(journal),
            'conf-pubs': block(conf),
            'updated': ' '.join(parts),
        },
        'index': {
            'journal-count': str(len(journal)),
            'first-year': str(first_year),
            'cites': cites,
        },
    }
    for page, fills in pages.items():
        path = PAGES[page]
        if not os.path.exists(path):
            continue
        with open(path, encoding='utf-8') as f:
            src = f.read()
        out = src
        for name, content in fills.items():
            pat = re.compile(r'(<!-- pubs:' + re.escape(name) + r' -->)(.*?)(<!-- /pubs:' + re.escape(name) + r' -->)', re.S)
            if not pat.search(out):
                if page == 'publications':
                    log(f'  ! marker "pubs:{name}" missing in {os.path.basename(path)}')
                continue
            out = pat.sub(lambda m: m.group(1) + content + m.group(3), out)
        if out != src:
            with open(path, 'w', encoding='utf-8') as f:
                f.write(out)
            log(f'  rendered {os.path.basename(path)}')


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--offline', action='store_true', help='only re-render the pages from data/publications.json')
    ap.add_argument('--refresh-metadata', action='store_true', help='re-pull Crossref metadata for existing papers')
    args = ap.parse_args()

    cfg = load_json(CONFIG, {})
    cfg.setdefault('author_pattern', r'koundinya')
    cfg.setdefault('author_display', 'Koundinya N T B N')
    cfg.setdefault('author_pattern_html', r'Koundinya,?\s*N\.?\s*T\.?\s*B\.?\s*N\.?|N\.?\s*T\.?\s*B\.?\s*N\.?\s*Koundinya|Koundinya')
    data = load_json(DATA, {'publications': []})
    store = Store(data, cfg)

    if not args.offline:
        used = []
        key = os.environ.get('SERPAPI_KEY', '').strip()
        if key:
            log('Reading Google Scholar (via SerpApi)...')
            articles, metrics = fetch_scholar(cfg, key)
            if articles:
                merge_scholar(store, articles, cfg)
                used.append('Google Scholar')
                log(f'  {len(articles)} papers on the Scholar profile')
            if metrics:
                data['scholar_metrics'] = metrics
        else:
            log('SERPAPI_KEY not set: skipping Google Scholar.')
        log('Reading ORCID...')
        works = fetch_orcid(cfg)
        if works is not None:
            merge_orcid(store, works, cfg)
            used.append('ORCID')
            log(f'  {len(works)} works on the ORCID record')
        if args.refresh_metadata:
            log('Refreshing metadata from Crossref...')
            refresh_metadata(store, cfg)
        log('Checking journal covers...')
        fetch_covers(store.items)
        if used:
            data['last_checked'] = today()
            data['last_sources'] = used
        else:
            log('No source could be reached. The list was not changed.')

    data['publications'] = sorted(store.items, key=sort_key)
    for i, p in enumerate(data['publications']):
        p['order'] = i
    save_json(DATA, data)
    render_pages(data, cfg)

    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write('## Publication update\n\n')
            if store.added:
                f.write('New papers added:\n\n' + '\n'.join(f'- {p["title"]} ({p.get("year")})' for p in store.added) + '\n\n')
            else:
                f.write('No new papers.\n\n')
            f.write('<details><summary>Log</summary>\n\n```\n' + '\n'.join(log_lines) + '\n```\n</details>\n')
    log(f'Done. {len(store.added)} new, {store.changed} field updates, {len(data["publications"])} total.')


if __name__ == '__main__':
    main()
