import json,re,sys
raw=open(sys.argv[1]).read(); d=json.loads(raw[raw.index('{'):])
bad=re.compile(r"subscribe|subscription|upgrade|\bbuy\b|purchase|checkout|\bprices?\b|pricing|€|\$|per (month|year)|start (a |the |your )?(\d+-day )?trial|choose (a|your) plan|see plans|pay now",re.I)
texts=[];clickable=[]
def walk(n):
    a=n.get('attributes',{})
    t=' '.join(x for x in [a.get('text'),a.get('accessibilityText'),a.get('hintText')] if x)
    if t: texts.append(t)
    if a.get('clickable')=='true' and t: clickable.append(t)
    for c in n.get('children',[]): walk(c)
walk(d)
hits=[t for t in texts if bad.search(t)]
chit=[t for t in clickable if bad.search(t)]
print(f"elements_with_text={len(texts)} clickable_with_text={len(clickable)} purchase_word_hits={len(hits)} clickable_purchase_hits={len(chit)}")
for h in hits: print("HIT:",h)
sys.exit(1 if hits else 0)
