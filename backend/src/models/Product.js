const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  sku: { type: String, required: true, unique: true },

  shortDescription: { type: String, default: '' },
  longDescription: { type: String, default: '' },

  price: { type: Number, required: true },       // selling price
  mrp: { type: Number, required: true },          // compare-at price

  category: { type: String, default: 'Home Decor' },
  tags: [{ type: String }],
  collections: [{ type: String }],        // which homepage carousels this product appears in (admin-controlled): featured | new-arrivals | best-sellers | recommended
  collectionRank: { type: Number, default: 100 }, // lower = earlier in a carousel

  material: { type: String, default: '' },
  dimensions: { type: String, default: '' },      // e.g. "50cm (L) x 22cm (H)"
  weight: { type: String, default: '' },

  features: [{ type: String }],
  careInstructions: [{ type: String }],
  whatsIncluded: { type: String, default: '' },

  images: [{ type: String }],                     // URLs (main image first)

  stock: { type: Number, default: 0, min: 0 },
  reserved: { type: Number, default: 0, min: 0 }, // reserved during active checkouts
  lowStockThreshold: { type: Number, default: 5 },

  seoTitle: { type: String, default: '' },
  seoDescription: { type: String, default: '' },

  status: { type: String, enum: ['active', 'draft', 'archived'], default: 'active' },
}, { timestamps: true });

productSchema.index({ status: 1, createdAt: -1 });
productSchema.index({ stock: 1 });

productSchema.virtual('available').get(function () {
  return Math.max(0, this.stock - this.reserved);
});

productSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, obj) => {
    obj.id = obj._id.toString();
    delete obj._id;
    delete obj.__v;
    return obj;
  }
});

module.exports = mongoose.model('Product', productSchema);
