import os, re

DOMAIN_MAP = {
  r"https://assets\.squarespace\.com/": "/assets.squarespace.com/",
  r"https://images\.squarespace-cdn\.com/": "/images.squarespace-cdn.com/",
  r"https://static1\.squarespace\.com/": "/static1.squarespace.com/",
  r"https://definitions\.sqspcdn\.com/": "/definitions.sqspcdn.com/",
  r"https://use\.typekit\.net/": "/use.typekit.net/",
  r"https://p\.typekit\.net/": "/p.typekit.net/",
  r"https://fonts\.googleapis\.com/": "/fonts.googleapis.com/",
  r"https://fonts\.gstatic\.com/": "/fonts.gstatic.com/",
}

def rewrite_file(fp: str):
  with open(fp, "r", encoding="utf-8", errors="ignore") as f:
    txt = f.read()
  orig = txt
  for pat, repl in DOMAIN_MAP.items():
    txt = re.sub(pat, repl, txt)
  if txt != orig:
    with open(fp, "w", encoding="utf-8") as f:
      f.write(txt)

root = "site"
for dirpath, _, filenames in os.walk(root):
  for name in filenames:
    if name.lower().endswith(".html"):
      rewrite_file(os.path.join(dirpath, name))

print("Done rewriting HTML to local asset paths.")


