/** Manual dispatch — always available, no API. The admin enters the courier name + tracking number by hand. */
module.exports = {
  id: 'manual', label: 'Manual dispatch', supportsApi: false, secrets: [], config: [],
  async testConnection() { return { ok: true, message: 'Manual dispatch needs no connection.' }; },
};
