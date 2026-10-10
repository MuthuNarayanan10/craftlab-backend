const Product = require('../models/Product');
const { getSettings } = require('../models/Settings');

const clean = (v, n = 40) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const slugify = (s) => clean(s, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();

/**
 * The category tree the admin manages: [{ name, slug, subcategories: [{ name, slug }] }].
 * Categories already used by products but not yet in the list are included (so nothing is ever hidden),
 * and saving from the admin persists them.
 */
async function getTree() {
  const s = await getSettings();
  const tree = (s.categories || []).map((c) => ({ name: c.name, slug: c.slug || slugify(c.name), subcategories: (c.subcategories || []).map((x) => ({ name: x.name, slug: x.slug || slugify(x.name) })) }));
  const used = await Product.find({ status: { $ne: 'archived' } }).select('category subcategory').lean();
  for (const p of used) {
    const cn = clean(p.category); if (!cn) continue;
    let c = tree.find((x) => same(x.name, cn));
    if (!c) { c = { name: cn, slug: slugify(cn), subcategories: [] }; tree.push(c); }
    const sn = clean(p.subcategory);
    if (sn && !c.subcategories.some((x) => same(x.name, sn))) c.subcategories.push({ name: sn, slug: slugify(sn) });
  }
  return tree;
}

/** Storefront view: only categories that have active products, with counts. */
async function publicTree() {
  const tree = await getTree();
  const active = await Product.find({ status: 'active' }).select('category subcategory').lean();
  return tree.map((c) => {
    const inCat = active.filter((p) => same(p.category, c.name));
    return { name: c.name, slug: c.slug, count: inCat.length, subcategories: c.subcategories.map((x) => ({ name: x.name, slug: x.slug, count: inCat.filter((p) => same(p.subcategory, x.name)).length })).filter((x) => x.count > 0) };
  }).filter((c) => c.count > 0);
}

/** Resolve what the admin typed/picked to the exact stored names. Sub-category is optional: no pick = none. */
async function resolve(category, subcategory) {
  const tree = await getTree();
  const cn = clean(category);
  if (!cn) return { category: '', subcategory: '' };
  const c = tree.find((x) => same(x.name, cn));
  if (!c) return { error: `Category “${cn}” doesn’t exist — add it under Categories first` };
  const sn = clean(subcategory);
  if (!sn) return { category: c.name, subcategory: '' };
  const sub = c.subcategories.find((x) => same(x.name, sn));
  if (!sub) return { error: `“${sn}” isn’t a sub-category of ${c.name}` };
  return { category: c.name, subcategory: sub.name };
}

/** Save the tree. Renames (`was`) are applied to products; removing something products still use is refused. */
async function saveTree(incoming) {
  if (!Array.isArray(incoming)) return { error: 'Invalid category list' };
  if (incoming.length > 60) return { error: 'Too many categories (max 60)' };
  const next = [], seen = new Set();
  for (const c of incoming) {
    const name = clean(c?.name); if (!name) continue;
    if (seen.has(name.toLowerCase())) return { error: `Category “${name}” is listed twice` };
    seen.add(name.toLowerCase());
    const subs = [], seenSub = new Set();
    for (const x of (c.subcategories || []).slice(0, 40)) {
      const sn = clean(x?.name); if (!sn) continue;
      if (seenSub.has(sn.toLowerCase())) return { error: `Sub-category “${sn}” is listed twice in ${name}` };
      seenSub.add(sn.toLowerCase());
      subs.push({ name: sn, slug: slugify(sn), was: clean(x.was) });
    }
    next.push({ name, slug: slugify(name), was: clean(c.was), subcategories: subs });
  }
  const current = await getTree();
  const products = await Product.find({ status: { $ne: 'archived' } }).select('category subcategory').lean();
  // what disappears must not be in use
  for (const old of current) {
    const keep = next.find((n) => same(n.was || n.name, old.name));
    const used = products.filter((p) => same(p.category, old.name)).length;
    if (!keep) { if (used) return { error: `Can’t remove “${old.name}”: ${used} product${used === 1 ? ' still uses' : 's still use'} it. Move them to another category first.` }; continue; }
    for (const os of old.subcategories) {
      if (keep.subcategories.some((n) => same(n.was || n.name, os.name))) continue;
      const u = products.filter((p) => same(p.category, old.name) && same(p.subcategory, os.name)).length;
      if (u) return { error: `Can’t remove sub-category “${os.name}” of ${old.name}: ${u} product${u === 1 ? ' uses' : 's use'} it. Move or clear them first.` };
    }
  }
  // apply renames to products
  for (const n of next) {
    const oldCat = n.was && !same(n.was, n.name) ? n.was : null;
    for (const sc of n.subcategories) if (sc.was && !same(sc.was, sc.name)) await Product.updateMany({ category: oldCat || n.name, subcategory: sc.was }, { $set: { subcategory: sc.name } });
    if (oldCat) await Product.updateMany({ category: oldCat }, { $set: { category: n.name } });
  }
  const s = await getSettings();
  s.categories = next.map((n) => ({ name: n.name, slug: n.slug, subcategories: n.subcategories.map((x) => ({ name: x.name, slug: x.slug })) }));
  await s.save();
  return { tree: await getTree() };
}
module.exports = { getTree, publicTree, resolve, saveTree, same, clean };
