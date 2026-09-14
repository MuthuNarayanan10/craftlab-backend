require('dotenv').config();
const connectDB = require('../src/db');
const Admin = require('../src/models/Admin');
const Product = require('../src/models/Product');

async function seed() {
  await connectDB();

  // --- Admin user ---
  const adminEmail = (process.env.SEED_ADMIN_EMAIL || '').toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    console.error('❌ Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env before seeding.');
    process.exit(1);
  }

  const existingAdmin = await Admin.findOne({ email: adminEmail });
  if (existingAdmin) {
    console.log(`ℹ️  Admin ${adminEmail} already exists — skipping.`);
  } else {
    const admin = new Admin({ name: 'Craft Lab Admin', email: adminEmail, role: 'ADMIN' });
    await admin.setPassword(adminPassword);
    await admin.save();
    console.log(`✅ Created admin login: ${adminEmail}`);
  }

  // --- Products (real data confirmed for launch) ---
  const products = [
    {
      name: 'Sculptural Wall Hook Rack',
      slug: 'sculptural-wall-hook-rack',
      sku: 'CRAFTLAB-HNG-01',
      shortDescription: 'A layered, sculptural wall organizer with varied-height wooden pegs — as much art as it is storage.',
      longDescription: "Bring natural character home. This wall-mounted rack brings sculptural form to everyday organisation — varied heights, a layered silhouette, and projecting elements that catch the light differently throughout the day. Made from solid wood with visible grain and natural tonal variation, no two pieces are quite the same. Works equally well in an entryway, bedroom, or dressing area — hold keys, scarves, and light accessories within easy reach, or simply let it stand as a sculptural accent on its own.",
      price: 2499,
      mrp: 2999,
      category: 'Wall Organizers',
      tags: ['wall decor', 'organizer', 'handcrafted', 'wood'],
      material: 'Solid wood, natural finish',
      dimensions: '50cm (Length) x 22cm (Width/Height)', // confirmed
      weight: 'TBD',
      features: [
        'Varied heights for a layered, dimensional silhouette',
        'Visible natural grain — no two pieces are identical',
        'Multiple projecting hooks for everyday essentials',
        'Wall-mounted, space-saving design',
      ],
      careInstructions: [
        'Wipe clean with a dry or slightly damp soft cloth',
        'Avoid direct, prolonged sunlight to preserve natural tone',
        'Keep away from excess moisture',
      ],
      whatsIncluded: '1 x Sculptural Wall Hook Rack, wall-mounting hardware',
      images: ['images/product1-1.jpg', 'images/product1-2.jpg', 'images/product1-detail-1.jpg', 'images/product1-detail-2.jpg', 'images/product1-detail-3.jpg'],
      stock: 25,
      lowStockThreshold: 5,
      seoTitle: 'Sculptural Wall Hook Rack | Handcrafted Wood Organizer — The Craft Lab',
      seoDescription: 'A sculptural, solid-wood wall hook rack with varied-height pegs for a layered, artisanal look. Handcrafted, natural grain, made to organise beautifully.',
      status: 'active',
    },
    {
      name: 'Classic Row Wall Hook Rack',
      slug: 'classic-row-wall-hook-rack',
      sku: 'CRAFTLAB-HNG-02',
      shortDescription: 'A clean, uniform row of solid wood hooks — simple storage, naturally beautiful.',
      longDescription: "Natural organisation for everyday living. A practical wall-mounted design that keeps everyday essentials organised and within easy reach — one rack, multiple everyday uses, from keys and scarves to caps, bags, and totes. Crafted from solid wood with the same natural grain and tonal warmth found across The Craft Lab's collection, this piece is compact, space-saving, and built for daily use.",
      price: 2499,
      mrp: 2999,
      category: 'Wall Organizers',
      tags: ['wall decor', 'organizer', 'handcrafted', 'wood'],
      material: 'Solid wood, natural finish',
      dimensions: '50cm (Length) x 20cm (Width/Height)', // confirmed from A+ content
      weight: 'TBD',
      features: [
        'Multiple hooks for convenient everyday organisation',
        'Natural wood character — distinctive grain and texture',
        'Space-saving, practical wall-mounted storage',
        'Versatile — keys, scarves, caps, bags, and totes',
      ],
      careInstructions: [
        'Wipe clean with a dry or slightly damp soft cloth',
        'Avoid direct, prolonged sunlight to preserve natural tone',
        'Keep away from excess moisture',
      ],
      whatsIncluded: '1 x Classic Row Wall Hook Rack, wall-mounting hardware',
      images: ['images/product2-1.jpg', 'images/product2-2.jpg', 'images/product2-detail-1.jpg', 'images/product2-detail-2.jpg', 'images/product2-detail-3.jpg'],
      stock: 25,
      lowStockThreshold: 5,
      seoTitle: 'Classic Row Wall Hook Rack | Handcrafted Wood Organizer — The Craft Lab',
      seoDescription: 'A clean, uniform row wall hook rack in solid wood. Simple, versatile everyday storage with natural grain and warm, artisanal character.',
      status: 'active',
    },
  ];

  for (const p of products) {
    const existing = await Product.findOne({ sku: p.sku });
    if (existing) {
      console.log(`ℹ️  Product ${p.sku} already exists — skipping.`);
    } else {
      await Product.create(p);
      console.log(`✅ Created product: ${p.name} (${p.sku})`);
    }
  }

  console.log('\n✅ Product images are pre-linked to files bundled in frontend/images/ — no upload needed to launch.');
  console.log('Done. You can now log in to the admin dashboard with the SEED_ADMIN_EMAIL/PASSWORD from your .env file.');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
