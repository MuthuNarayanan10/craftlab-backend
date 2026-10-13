/** Files attached to a support message: up to 4, images or a PDF, as data URLs (kept inside the ticket). */
const MAX_FILES = 4, MAX_CHARS = 1400000;
const OK = /^data:(image\/(jpeg|png|webp)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;
function cleanAttachments(list) {
  if (list === undefined || list === null || list === '') return [];
  if (!Array.isArray(list)) throw new Error('Attachments are invalid');
  if (list.length > MAX_FILES) throw new Error(`You can attach up to ${MAX_FILES} files`);
  return list.map((a) => {
    const data = typeof a === 'string' ? a : a && a.data;
    if (typeof data !== 'string' || data.length > MAX_CHARS || !OK.test(data)) throw new Error('One of the attachments is not allowed — use a photo (JPG/PNG/WebP) or a PDF under about 1 MB');
    return { name: String((a && a.name) || (data.startsWith('data:application/pdf') ? 'document.pdf' : 'photo')).replace(/[^\w.\- ]/g, '').slice(0, 60), data };
  });
}
module.exports = { cleanAttachments, MAX_FILES };
