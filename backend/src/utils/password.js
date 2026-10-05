/** Admin password rules — long beats clever. Returns an error message, or '' if acceptable. */
function checkPasswordStrength(pw, email = '') {
  pw = String(pw || '');
  if (pw.length < 12) return 'Use at least 12 characters (a short sentence works well).';
  if (pw.length > 128) return 'That password is too long (max 128 characters).';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Include both letters and numbers.';
  if (email && pw.toLowerCase().includes(String(email).split('@')[0].toLowerCase()) && String(email).split('@')[0].length >= 4) return 'Don’t include your email name in the password.';
  if (/^(.)\1+$/.test(pw) || /(password|12345678|qwertyuiop)/i.test(pw)) return 'That password is too easy to guess.';
  return '';
}
module.exports = { checkPasswordStrength };
