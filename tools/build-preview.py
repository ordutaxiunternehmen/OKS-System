# Baut die Vorschau-Seite der Admin-App (Beispieldaten) für Claude-Artefakte.
import base64, re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
s = (root/'web/admin/index.html').read_text()
icon = 'data:image/png;base64,' + base64.b64encode((root/'web/admin/icon-admin-192.png').read_bytes()).decode()
pre = '<script>window.CP_CONFIG={};</script><script>' + (root/'tools/admin-preview.js').read_text() + '</script>'
s = s.replace('<script src="/config.js"></script>', pre)
s = re.sub(r'<link rel="manifest"[^>]*>\n?', '', s).replace('/admin/icon-admin-192.png', icon)
s = s.replace('<title>Cockpit Plus – Admin</title>', '<title>Abo-Verfahren – Admin-App (Vorschau)</title>')
out = pathlib.Path('/home/claude/abo-art/admin.html'); out.write_text(s); print(out, len(s))
