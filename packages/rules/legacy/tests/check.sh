#!/bin/bash
cd /home/claude/work
mkdir -p /tmp/claude-0/syn 2>/dev/null
ok=1
for f in file_29.js file_24.js file_18.js DriverApp.gs; do
  sed 's/\r$//' "$f" > /tmp/claude-0/syn/"$(basename $f .gs).js"
  if node --check /tmp/claude-0/syn/"$(basename $f .gs).js" 2>/tmp/claude-0/syn/err; then
    echo "  syntax OK  $f"
  else
    echo "  SYNTAX FAIL $f"; cat /tmp/claude-0/syn/err | head -8; ok=0
  fi
done
for f in TripsPage.html DriverAppPage.html; do
  python3 - "$f" <<'PY'
import sys, re, io, subprocess, os
p = sys.argv[1]
s = io.open(p, encoding='utf-8', newline='').read().replace('\r\n','\n')
blocks = re.findall(r'<script[^>]*>(.*?)</script>', s, re.S)
if not blocks: print('  no <script> found in', p); sys.exit(0)
bad = 0
for i, b in enumerate(blocks):
    b = re.sub(r'<\?!?=?.*?\?>', '0', b, flags=re.S)   # apps script scriptlets
    t = '/tmp/claude-0/syn/%s_%d.js' % (os.path.basename(p).replace('.','_'), i)
    io.open(t,'w',encoding='utf-8').write(b)
    r = subprocess.run(['node','--check',t], capture_output=True, text=True)
    if r.returncode: bad = 1; print('  SYNTAX FAIL %s block %d' % (p, i)); print('\n'.join(r.stderr.splitlines()[:8]))
if not bad: print('  syntax OK  %s (%d script block(s))' % (p, len(blocks)))
PY
done
