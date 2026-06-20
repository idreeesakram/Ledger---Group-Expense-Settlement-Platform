const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const app = express();
app.use(express.json());
app.use(express.static('public'));

// ---------- split logic ----------
function splitEqually(totalCents, memberIds) {
  const n = memberIds.length;
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  return memberIds.map((id, idx) => ({
    member_id: id,
    owed_cents: base + (idx < remainder ? 1 : 0)
  }));
}

// ---------- balance logic ----------
function getBalances(groupId) {
  const members = db.prepare('SELECT id, name, initial_budget_cents FROM members WHERE group_id = ?').all(groupId);
  const balances = {};
  members.forEach(m => balances[m.id] = { id: m.id, name: m.name, balance_cents: m.initial_budget_cents || 0, net_balance_cents: 0 });

  db.prepare(`SELECT paid_by AS member_id, SUM(amount_cents) AS total
              FROM expenses WHERE group_id = ? GROUP BY paid_by`)
    .all(groupId)
    .forEach(p => { if (balances[p.member_id]) { balances[p.member_id].balance_cents += p.total; balances[p.member_id].net_balance_cents += p.total; } });

  db.prepare(`SELECT es.member_id, SUM(es.owed_cents) AS total
              FROM expense_splits es JOIN expenses e ON es.expense_id = e.id
              WHERE e.group_id = ? GROUP BY es.member_id`)
    .all(groupId)
    .forEach(o => { if (balances[o.member_id]) { balances[o.member_id].balance_cents -= o.total; balances[o.member_id].net_balance_cents -= o.total; } });

  return Object.values(balances);
}

// ---------- settle-up ----------
function computeSettlement(balances) {
  const creditors = balances.filter(b => b.net_balance_cents > 0).map(b => ({ ...b })).sort((a, b) => b.net_balance_cents - a.net_balance_cents);
  const debtors = balances.filter(b => b.net_balance_cents < 0).map(b => ({ ...b, net_balance_cents: -b.net_balance_cents })).sort((a, b) => b.net_balance_cents - a.net_balance_cents);
  const tx = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i], c = creditors[j];
    const amt = Math.min(d.net_balance_cents, c.net_balance_cents);
    if (amt > 0) tx.push({ from: d.name, to: c.name, amount_cents: amt });
    d.net_balance_cents -= amt; c.net_balance_cents -= amt;
    if (d.net_balance_cents === 0) i++;
    if (c.net_balance_cents === 0) j++;
  }
  return tx;
}

// ---------- auth middleware ----------
function requireMember(req, res, next) {
  const token = req.headers['x-member-token'];
  if (!token) return res.status(401).json({ error: 'missing X-Member-Token header' });
  const member = db.prepare('SELECT * FROM members WHERE token = ?').get(token);
  if (!member) return res.status(401).json({ error: 'invalid token' });
  if (String(member.group_id) !== String(req.params.id)) return res.status(403).json({ error: 'not a member of this group' });
  req.member = member;
  next();
}

// ---------- routes ----------
app.post('/groups', (req, res) => {
  const r = db.prepare('INSERT INTO groups (name) VALUES (?)').run(req.body.name);
  res.json({ id: r.lastInsertRowid, name: req.body.name });
});

app.get('/groups/:id', requireMember, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id=?').get(req.params.id);
  const members = db.prepare('SELECT id, name, group_id FROM members WHERE group_id=?').all(req.params.id);
  res.json({ ...group, members });
});

app.post('/groups/:id/members', (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  const initialBudget = req.body.initial_budget || 0;
  const initialBudgetCents = Math.round(initialBudget * 100);
  const r = db.prepare('INSERT INTO members (group_id, name, token, initial_budget_cents) VALUES (?,?,?,?)').run(req.params.id, req.body.name, token, initialBudgetCents);
  res.json({ id: r.lastInsertRowid, name: req.body.name, token, initial_budget_cents: initialBudgetCents });
});

app.post('/groups/:id/expenses', requireMember, (req, res) => {
  const groupId = req.params.id;
  const { description, amount, paid_by, split_type = 'equal', splits } = req.body;
  const amount_cents = Math.round(amount * 100);
  const memberIds = db.prepare('SELECT id FROM members WHERE group_id=?').all(groupId).map(m => m.id);

  let splitRows;
  if (split_type === 'equal') {
    splitRows = splitEqually(amount_cents, memberIds);
  } else if (split_type === 'exact') {
    splitRows = splits.map(s => ({ member_id: s.member_id, owed_cents: Math.round(s.amount * 100) }));
    const sum = splitRows.reduce((a, s) => a + s.owed_cents, 0);
    if (sum !== amount_cents) return res.status(400).json({ error: `splits sum ${sum} != ${amount_cents}` });
  } else if (split_type === 'percent') {
    let allocated = 0;
    splitRows = splits.map(s => { const c = Math.round(amount_cents * s.percent / 100); allocated += c; return { member_id: s.member_id, owed_cents: c }; });
    splitRows[splitRows.length - 1].owed_cents += (amount_cents - allocated);
  } else {
    return res.status(400).json({ error: 'invalid split_type' });
  }

  const insExpense = db.prepare('INSERT INTO expenses (group_id, description, amount_cents, paid_by) VALUES (?,?,?,?)');
  const insSplit = db.prepare('INSERT INTO expense_splits (expense_id, member_id, owed_cents) VALUES (?,?,?)');
  const id = db.transaction(() => {
    const r = insExpense.run(groupId, description, amount_cents, paid_by);
    splitRows.forEach(s => insSplit.run(r.lastInsertRowid, s.member_id, s.owed_cents));
    return r.lastInsertRowid;
  })();
  res.json({ id, amount_cents, splits: splitRows });
});

app.get('/groups/:id/balances', requireMember, (req, res) => res.json(getBalances(req.params.id)));
app.get('/groups/:id/settlement', requireMember, (req, res) => res.json(computeSettlement(getBalances(req.params.id))));

app.get('/groups/:id/activity', requireMember, (req, res) => {
  const expenses = db.prepare(`SELECT e.id, e.description, e.amount_cents, e.created_at, m.name AS paid_by_name
    FROM expenses e JOIN members m ON e.paid_by = m.id WHERE e.group_id = ? ORDER BY e.created_at`).all(req.params.id);
  res.json({ expenses, outstanding_settlements: computeSettlement(getBalances(req.params.id)) });
});

app.get('/groups/:id/members/:memberId/history', requireMember, (req, res) => {
  const { id, memberId } = req.params;
  const paid = db.prepare(`SELECT description, amount_cents, created_at FROM expenses WHERE group_id=? AND paid_by=?`).all(id, memberId);
  const owed = db.prepare(`SELECT es.owed_cents, e.description, e.created_at FROM expense_splits es JOIN expenses e ON es.expense_id=e.id WHERE e.group_id=? AND es.member_id=?`).all(id, memberId);
  let csv = 'type,description,amount,date\n';
  paid.forEach(p => csv += `paid,${p.description},${(p.amount_cents / 100).toFixed(2)},${p.created_at}\n`);
  owed.forEach(o => csv += `owed,${o.description},${(o.owed_cents / 100).toFixed(2)},${o.created_at}\n`);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=history_${memberId}.csv`);
  res.send(csv);
});

app.listen(3000, () => console.log('Ledger running at http://localhost:3000'));