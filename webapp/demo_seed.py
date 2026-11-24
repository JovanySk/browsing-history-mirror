#!/usr/bin/env python3
"""Create a throwaway data directory filled with synthetic, fictional history.

Every domain is under *.example.*, every title is invented, and nothing is read
from a real browser. Records go through the real collector route
(POST /api/collector/sync), so storage, projection and indexing run exactly as
they do in production.

    export HISTORIAL_DATA=$PWD/.demo-data
    python webapp/demo_seed.py
    MIRROR_DOMAIN=localhost python webapp/server.py

The demo username and password are printed to this console only.
"""
import base64, hashlib, json, math, os, pathlib, random, secrets, shutil, struct, sys, threading, time, urllib.request, zlib

ROOT = pathlib.Path(__file__).resolve().parent
DATA = pathlib.Path(os.environ.get('HISTORIAL_DATA') or ROOT.parent / '.demo-data').resolve()
MARKER = '.demo-data'
os.environ['HISTORIAL_DATA'] = str(DATA)
os.environ.setdefault('MIRROR_DOMAIN', 'localhost')
sys.path.insert(0, str(ROOT))

DAY = 86400000
DEVICES = {'laptop': 'Laptop', 'vps': 'Phone'}

# Fictional sites: (host, brand, weight laptop, weight phone, icon color, icon shape, titles)
SITES = [
    ('docs.example.dev', 'Example Docs', 9, 1, (16, 185, 129), 'bars', [
        'Referencia de la API Fetch', 'Guía de async/await paso a paso', 'Array.prototype.flatMap()',
        'Módulos ES en el navegador', 'IntersectionObserver: guía práctica', 'Server-Sent Events: EventSource',
        'IndexedDB: transacciones y cursores', 'Service workers en Manifest V3', 'AbortController y tiempos de espera',
        'Intl.DateTimeFormat con zonas horarias', 'CSS: container queries', 'CSS: la propiedad text-wrap']),
    ('code.example.dev', 'ExampleCode', 8, 1, (99, 102, 241), 'ring', [
        'example-org/timeline-kit: Pull request #42', 'Issues · example-org/sync-engine', 'Acciones · build #318 aprobado',
        'example-org/timeline-kit: Comparar cambios', 'Revisión: paginación por rowid', 'example-org/panel-ui: README',
        'Lanzamiento v2.3.0 · example-org/sync-engine', 'Discusión: reintentos con backoff']),
    ('learn.example.edu', 'Example Learn', 5, 1, (245, 158, 11), 'tri', [
        'Curso de SQL: índices y planes de consulta · Lección 4', 'Estructuras de datos: árboles B',
        'Sistemas distribuidos: relojes lógicos', 'Redes: HTTP/2 y multiplexación', 'Bases de datos: aislamiento y WAL',
        'Algoritmos: búsqueda binaria en la práctica']),
    ('forum.example.org', 'Example Forum', 5, 2, (236, 72, 153), 'dots', [
        '¿Cómo evitar bloqueos en SQLite con WAL?', 'Diferencia entre debounce y throttle',
        '¿Por qué mi EventSource se reconecta cada 50 s?', 'Paginar sin OFFSET en tablas grandes',
        'systemd: Type=notify y watchdog', 'Mejor forma de deduplicar eventos']),
    ('blog.example.dev', 'Example Blog', 3, 2, None, None, [
        'Server-Sent Events sin frameworks', 'Lo que aprendí migrando 80.000 registros',
        'Diseñar para el modo oscuro primero', 'Colas idempotentes en 50 líneas', 'Notas sobre tipografía en interfaces']),
    ('cloud.example.dev', 'Example Cloud', 4, 1, (14, 165, 233), 'square', [
        'Panel de instancias', 'Métricas de CPU · vps-demo', 'Registros del servicio · panel-demo',
        'Copias de seguridad programadas', 'Reglas de firewall']),
    ('news.example.org', 'Example News', 2, 8, (239, 68, 68), 'lines', [
        'La ciudad estrena una red de bicicletas eléctricas', 'Mercados cierran la semana con ligeras alzas',
        'Nueva biblioteca pública abre sus puertas en el centro', 'Temporada de lluvias: lo que hay que saber',
        'Investigadores presentan un método para reciclar baterías', 'El festival de cine anuncia su programa',
        'Así funciona el nuevo sistema de transporte nocturno', 'Opinión: el valor de las cosas que duran']),
    ('video.example.tv', 'ExampleTV', 2, 6, (168, 85, 247), 'play', [
        'Charla: arquitectura offline-first en 20 minutos', 'Tutorial: tu primera extensión de Chrome',
        'Documental corto: cómo se hace el papel', 'Directo: construyendo un panel en vivo',
        'Receta rápida: pasta al limón', 'Lo-fi para programar · 2 horas']),
    ('shop.example.com', 'Example Shop', 1, 4, None, None, [
        'Teclado mecánico compacto 75%', 'Carrito (2)', 'Monitor 27 pulgadas QHD', 'Funda para laptop de 14"',
        'Seguimiento de pedido', 'Audífonos inalámbricos con cancelación de ruido']),
    ('mail.example.com', 'Example Mail', 3, 3, None, None, [
        'Bandeja de entrada (3)', 'Bandeja de entrada', 'Redactar mensaje', 'Bandeja de entrada (1)']),
    ('wiki.example.org', 'Example Wiki', 3, 2, None, None, [
        'Algoritmo de Dijkstra', 'Codificación UTF-8', 'Historia de la imprenta', 'Teorema CAP', 'Árbol B+']),
    ('maps.example.com', 'Example Maps', 1, 3, None, None, [
        'Cafeterías cerca', 'Ruta al centro en bicicleta', 'Parques con área para correr', 'Librerías abiertas ahora']),
    ('design.example.com', 'Example Design', 2, 1, None, None, [
        'Paleta de colores: esmeralda', 'Escalas tipográficas', 'Sistema de espaciado de 4 px', 'Iconos de línea 1.5 px']),
    ('weather.example.org', 'Example Weather', 1, 3, None, None, [
        'Pronóstico de 10 días', 'Radar de lluvia', 'Calidad del aire hoy']),
    ('recipes.example.com', 'Example Recipes', 1, 3, None, None, [
        'Pan de masa madre en 24 horas', 'Tacos de verduras asadas', 'Sopa de lentejas fácil', 'Galletas de avena sin horno']),
]


def slug(text):
    keep = ''.join(c.lower() if c.isalnum() else '-' for c in text.translate(str.maketrans('áéíóúñü', 'aeiounu', '¿?"#()·')))
    return '-'.join(part for part in keep.split('-') if part)[:60]


def png_icon(color, shape, size=32, scale=4):
    """A small rounded-square favicon drawn with supersampling, stdlib only."""
    big = size * scale
    def inside(x, y):
        r = 7 * scale; cx = min(max(x, r), big - r); cy = min(max(y, r), big - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    def glyph(x, y):
        u, v = x / big, y / big
        if shape == 'bars': return any(abs(v - c) < .055 and .26 < u < e for c, e in ((.34, .74), (.5, .66), (.66, .7)))
        if shape == 'ring': return .17 < math.hypot(u - .5, v - .5) < .27
        if shape == 'tri': return v > .28 and v < .72 and abs(u - .5) < (v - .28) * .62
        if shape == 'dots': return any(math.hypot(u - c, v - .5) < .07 for c in (.3, .5, .7))
        if shape == 'square': return .3 < u < .7 and .3 < v < .7 and not (.4 < u < .6 and .4 < v < .6)
        if shape == 'lines': return .26 < u < .74 and any(abs(v - c) < .045 for c in (.32, .47, .62)) and not (v > .55 and u > .58)
        if shape == 'play': return .36 < u < .7 and abs(v - .5) < (.7 - u) * .62
        return False
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            cover = mark = 0
            for sy in range(scale):
                for sx in range(scale):
                    px, py = x * scale + sx + .5, y * scale + sy + .5
                    if inside(px, py):
                        cover += 1; mark += glyph(px, py)
            n = scale * scale; a = cover / n; m = mark / max(cover, 1)
            rgb = [round(c * (1 - m) + 255 * m) for c in color]
            row += bytes(rgb + [round(a * 255)])
        rows.append(bytes(row))
    def chunk(kind, data): return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')


def visit(device, when, site, title, rng, counter):
    host, brand = site[0], site[1]
    url = 'https://' + host + '/' + slug(title)
    visit_id = str(counter)
    return {'fingerprint': f'{when}|{url}|{visit_id}', 'visitTime': when, 'url': url, 'title': title + ' · ' + brand,
            'transition': rng.choice(['link', 'link', 'link', 'typed', 'auto_bookmark']), 'referringVisitId': None,
            'visitId': visit_id, 'chromeHistoryId': str(1000 + counter), 'source': 'live', 'isLocal': True,
            'capturedAt': when + rng.randint(400, 2500), 'lastSeenAt': when + 3000, 'chromeState': 'present',
            'deletedAt': None, 'lastVerifiedAt': when + 3000}


def generate(now, rng, total=1500):
    """Sessions of related visits, laptop by day, phone in the evening."""
    rows = {device: [] for device in DEVICES}
    start = now - 10 * DAY; counter = 5000; recent = set()
    while sum(len(v) for v in rows.values()) < total:
        when = rng.randint(start, now - 6 * 60000)
        hour = time.localtime(when / 1000).tm_hour
        if hour < 7 and rng.random() < .97: continue
        device = 'laptop' if (9 <= hour < 19 and rng.random() < .82) or rng.random() < .35 else 'vps'
        weights = [site[2] if device == 'laptop' else site[3] for site in SITES]
        site = rng.choices(SITES, weights)[0]; pool = rng.sample(site[6], len(site[6]))
        for _ in range(rng.randint(2, 9)):
            counter += 1; title = pool.pop()
            # Skip a page already opened on this device within the same hour.
            if (device, title, when // 3600000) not in recent:
                recent.add((device, title, when // 3600000))
                rows[device].append(visit(device, when, site, title, rng, counter))
            when += rng.randint(15, 420) * 1000
            if when >= now - 60000: break
            if not pool or rng.random() < .25:
                site = rng.choices(SITES, weights)[0]; pool = rng.sample(site[6], len(site[6]))
    # A few visits removed from Chrome; the mirror keeps the copy.
    for device, items in rows.items():
        for row in rng.sample(items, 14 if device == 'laptop' else 7):
            row['chromeState'] = 'deleted'; row['deletedAt'] = row['visitTime'] + rng.randint(1, 48) * 3600000
            row['deletedAt'] = min(row['deletedAt'], now - 120000); row['lastVerifiedAt'] = row['deletedAt']
    return rows


def presence(now, device='laptop'):
    title = 'Directo: construyendo un panel en vivo · ExampleTV'
    url = 'https://video.example.tv/' + slug('Directo: construyendo un panel en vivo')
    return {'local': {'mirrorDeviceId': 'demo-' + device, 'presenceShareEnabled': True, 'presenceDeviceName': DEVICES[device]},
            'sync': {'sharedPresence': {'active': True, 'url': url, 'title': title, 'host': 'video.example.tv',
                                        'deviceId': 'demo-' + device, 'deviceName': DEVICES[device],
                                        'since': now - 7 * 60000, 'lastSeenAt': now}}}


def post(base, token, body):
    request = urllib.request.Request(base + '/api/collector/sync', data=json.dumps(body).encode(), method='POST',
                                     headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read())


def prepare_directory():
    if DATA.exists() and any(DATA.iterdir()):
        if not (DATA / MARKER).exists():
            sys.exit(f'Refusing to use {DATA}: it is not empty and was not created by demo_seed.py.')
        shutil.rmtree(DATA)
    DATA.mkdir(parents=True)
    (DATA / MARKER).write_text('Synthetic demo data. Safe to delete.\n', encoding='utf-8')


def write_credentials():
    tokens = {device: 'demo-' + secrets.token_urlsafe(24) for device in DEVICES}
    password = 'demo-' + secrets.token_urlsafe(9)
    activation = secrets.token_urlsafe(24); salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=32768, r=8, p=1, maxmem=128 * 1024 * 1024).hex()
    access = {'username': 'demo', 'salt': salt.hex(), 'password_hash': digest,
              'activation_hash': hashlib.sha256(activation.encode()).hexdigest()}
    (DATA / 'tokens.json').write_text(json.dumps(tokens, indent=2), encoding='utf-8')
    (DATA / 'access.json').write_text(json.dumps(access, indent=2), encoding='utf-8')
    return tokens, access, password, activation


def main():
    prepare_directory()
    tokens, access, password, activation = write_credentials()
    import server, archive_worker
    server.TOKENS.update(tokens); server.ACCESS.update(access)
    server.initialize()
    # Serve the real handler on a private port while seeding; projection runs inline.
    httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = 'http://127.0.0.1:%d' % httpd.server_address[1]
    rng = random.Random(20261124); now = int(time.time() * 1000)
    rows = generate(now, rng)
    icons = [{'host': s[0], 'data': base64.b64encode(png_icon(s[4], s[5])).decode()} for s in SITES if s[4]]
    for device, items in rows.items():
        items.sort(key=lambda row: row['visitTime'])
        for offset in range(0, len(items), 250):
            post(base, tokens[device], {'label': DEVICES[device], 'stores': {'visits': items[offset:offset + 250]}})
        post(base, tokens[device], {'label': DEVICES[device], 'icons': icons if device == 'laptop' else [],
                                    'counts': {'visits': len(items)}, 'state': presence(now, device) if device == 'laptop' else {'local': {}, 'sync': {}}})
    deleted = sorted(row['deletedAt'] for items in rows.values() for row in items if row['deletedAt'])
    post(base, tokens['laptop'], {'label': 'Laptop', 'stores': {'events': [
        {'id': 'demo-delete-%d' % i, 'type': 'chrome_history_deleted', 'time': when, 'details': {'allHistory': False, 'urls': []}}
        for i, when in enumerate(deleted[-2:])]}})
    # Drain the projection queue the same way the live projection thread does.
    while batch := server.projection_fetch():
        for source in {row['source'] for row in batch}:
            server.LIVE_ARCHIVE.changed(source, {'visits': [{'fingerprint': row['item_key']} for row in batch if row['source'] == source]})
            server.projection_ack([row for row in batch if row['source'] == source])
    httpd.shutdown()
    for scope in ('all', 'laptop', 'vps'):
        archive_worker.rebuild(scope)
    server.LIVE_ARCHIVE.build_search_index()
    count = sum(len(items) for items in rows.values())
    print('\nSynthetic demo data ready (%d visits, %d marked deleted) in %s' % (count, len(deleted), DATA))
    print('  Start:     HISTORIAL_DATA="%s" MIRROR_DOMAIN=localhost python webapp/server.py' % DATA)
    print('  Open:      http://localhost:6082/')
    print('  Username:  demo')
    print('  Password:  %s' % password)
    print('  One-click: http://localhost:6082/#acceso=%s' % activation)
    print('These credentials are local to this throwaway directory. Delete it when done.')


if __name__ == '__main__':
    main()
