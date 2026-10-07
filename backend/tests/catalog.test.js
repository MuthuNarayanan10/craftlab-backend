const test = require('node:test'); const assert = require('node:assert/strict');
const P = require('../src/utils/pincode');

test('PIN validation: 6 digits, never starting with 0', () => {
  assert.equal(P.validPin('600001'), true); assert.equal(P.validPin('600 001'), true); for (const b of ['012345', '60001', '6000011', 'abcdef', '', null]) assert.equal(P.validPin(b), false, String(b));
});
test('CSV import: headers by name, yes/no flags, duplicates (last wins), bad rows reported, quotes, BOM, CRLF', () => {
  const csv = '\uFEFFPincode,City,State,Serviceable,COD,ETA Days\r\n600001,"Chennai, GPO",Tamil Nadu,yes,yes,2\r\n560001,Bengaluru,Karnataka,no,0,\r\n12345,Bad,Nowhere,yes,yes,1\r\n600001,Chennai,Tamil Nadu,yes,no,3\r\n110001,New Delhi,Delhi,,,\r\n';
  const { rows, errors } = P.parsePincodeCsv(csv);
  assert.equal(rows.length, 3); assert.equal(errors.length, 1); assert.match(errors[0], /line 4.*12345.*valid 6-digit/);
  const chennai = rows.find((r) => r.pincode === '600001'); assert.deepEqual([chennai.city, chennai.codAvailable, chennai.etaDays], ['Chennai', false, 3], 'a repeated PIN keeps its last row');
  assert.deepEqual(rows.find((r) => r.pincode === '560001'), { pincode: '560001', city: 'Bengaluru', state: 'Karnataka', serviceable: false, codAvailable: false, etaDays: 0 });
  assert.deepEqual(rows.find((r) => r.pincode === '110001'), { pincode: '110001', city: 'New Delhi', state: 'Delhi', serviceable: true, codAvailable: true, etaDays: 0 }, 'empty flags default to yes');
  const plain = P.parsePincodeCsv('600001,Chennai,Tamil Nadu\n600002,Chennai,Tamil Nadu'); assert.equal(plain.rows.length, 2, 'no header: pincode,city,state');
  assert.match(P.parsePincodeCsv('').errors[0], /empty/); assert.match(P.parsePincodeCsv('pincode\n' + Array.from({ length: 30 }, (_, i) => 100001 + i).join('\n'), { max: 5 }).errors[0], /Too many rows/);
});
test('expected delivery date: PIN override beats the method; wording for same-day, single day and ranges', () => {
  const from = new Date('2026-10-05T06:00:00Z'); const m = { etaMinDays: 5, etaMaxDays: 7 };
  const a = P.expectedDelivery(m, null, from); assert.match(a.text, /^Delivery between .* and .*$/); assert.equal(a.latest.toISOString().slice(0, 10), '2026-10-12'); assert.equal(a.earliest.toISOString().slice(0, 10), '2026-10-10');
  const b = P.expectedDelivery(m, { etaDays: 2 }, from); assert.match(b.text, /^Delivery by /); assert.equal(b.latest.toISOString().slice(0, 10), '2026-10-07');
  assert.equal(P.expectedDelivery({ etaMaxDays: 0 }, null, from), null);
});

const RM = require('../src/utils/rewardsMath'); const gen = require('../src/utils/generateOrderNumber');
const S5 = { rewardsEnabled: true, rewardEarnPercent: 5, rewardRedeemMaxPercent: 20, rewardRedeemMinPoints: 100, cashbackPercent: 0, cashbackMinOrder: 0, giftCardsEnabled: true };
test('earning: ₹1000 → 50 points, ₹500 → 25 (5%); fees and wallet-paid parts earn nothing; off switch; cashback only on prepaid', () => {
  const e = (eligible, extra = {}, pm = 'cod') => RM.earnFor({ eligible, paymentMethod: pm, settings: { ...S5, ...extra } });
  assert.deepEqual(e(1000), { points: 50, cashback: 0 }); assert.deepEqual(e(500), { points: 25, cashback: 0 }); assert.equal(e(2499).points, 124, 'rounds down'); assert.equal(e(19).points, 0); assert.equal(e(0).points, 0);
  assert.equal(e(1000, { rewardsEnabled: false }).points, 0); assert.deepEqual(e(1000, { cashbackPercent: 2 }, 'online'), { points: 50, cashback: 20 }); assert.equal(e(1000, { cashbackPercent: 2 }, 'cod').cashback, 0, 'cashback is for prepaid orders'); assert.equal(e(1000, { cashbackPercent: 2, cashbackMinOrder: 1500 }, 'online').cashback, 0);
});
test('redeeming: capped at 20% of goods and at the balance; below the minimum nothing applies; gift cards cover shipping too; cash is what is left', () => {
  assert.equal(RM.maxRedeemPoints({ goodsPayable: 1000, balance: 300, settings: S5 }), 200); assert.equal(RM.maxRedeemPoints({ goodsPayable: 1000, balance: 150, settings: S5 }), 150); assert.equal(RM.maxRedeemPoints({ goodsPayable: 1000, balance: 99, settings: S5 }), 0, 'under the 100-point minimum'); assert.equal(RM.maxRedeemPoints({ goodsPayable: 300, balance: 500, settings: S5 }), 0, '20% of ₹300 is 60 < minimum');
  const p = RM.plan({ goodsPayable: 1000, shipping: 80, codFee: 0, pointsRequested: Infinity, balance: 300, giftCards: [{ id: 'a', code: 'A', balance: 500 }, { id: 'b', code: 'B', balance: 900 }], settings: S5 });
  assert.equal(p.pointsUsed, 200); assert.deepEqual(p.gift.map((g) => g.amount), [500, 380], 'cards are used in order, only as much as needed'); assert.equal(p.cashTotal, 0); assert.equal(p.walletTotal, 1080); assert.equal(p.eligible, 0);
  const q = RM.plan({ goodsPayable: 1000, shipping: 80, pointsRequested: 200, balance: 300, settings: S5 }); assert.equal(q.cashTotal, 880); assert.equal(q.eligible, 800, 'only goods paid in cash earn points — not shipping');
  assert.equal(RM.plan({ goodsPayable: 1000, pointsRequested: 500, balance: 300, giftCards: [], settings: { ...S5, rewardsEnabled: false } }).pointsUsed, 0);
  assert.equal(RM.plan({ goodsPayable: 1000, pointsRequested: 50, balance: 300, settings: S5 }).pointsUsed, 0, 'asking for 50 when the minimum is 100 applies nothing'); assert.equal(RM.plan({ goodsPayable: 1000, pointsRequested: 100, balance: 300, settings: S5 }).pointsUsed, 100);
  assert.equal(RM.plan({ goodsPayable: 1000, giftCards: [{ id: 'a', code: 'A', balance: 500 }], settings: { ...S5, giftCardsEnabled: false } }).giftTotal, 0);
});
test('wallet share of a cash refund is proportional', () => { const o = { total: 800, wallet: { pointsValue: 200, giftTotal: 0 } }; assert.equal(RM.walletShareOfCash(o, 800), 200); assert.equal(RM.walletShareOfCash(o, 400), 100); assert.equal(RM.walletShareOfCash({ total: 500, wallet: {} }, 500), 0); });
test('order numbers: FY2026CL001 — Indian financial year (April–March, India time)', () => {
  assert.equal(gen.financialYear(new Date('2026-03-31T18:29:59Z')), 2025, '31 Mar 23:59:59 IST is still FY2025'); assert.equal(gen.financialYear(new Date('2026-03-31T18:30:00Z')), 2026, '1 Apr 00:00 IST starts FY2026');
  assert.equal(gen.financialYear(new Date('2026-10-06T10:00:00Z')), 2026); assert.equal(gen.financialYear(new Date('2027-02-14T10:00:00Z')), 2026, 'Jan–Mar belong to the FY that began the previous April'); assert.equal(gen.financialYear(new Date('2027-04-01T00:00:00Z')), 2027);
});
