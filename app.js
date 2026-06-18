let groupId;
let currentMembers = [];
let memberTokens = {};
let actingAs = null;

function authHeaders() {
  return actingAs ? { 'X-Member-Token': memberTokens[actingAs] } : {};
}

async function createGroup() {
  const name = document.getElementById('groupName').value;
  const g = await fetch('/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  }).then(r => r.json());
  groupId = g.id;
  document.getElementById('gName').textContent = g.name;
  document.getElementById('createView').style.display = 'none';
  document.getElementById('groupView').style.display = 'block';
}

async function addMember() {
  const name = document.getElementById('memberName').value;
  const m = await fetch(`/groups/${groupId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  }).then(r => r.json());
  memberTokens[m.id] = m.token;
  document.getElementById('memberName').value = '';
  if (actingAs === null) {
    actingAs = m.id;
  }
  await refresh();
}

function setActingAs() {
  actingAs = parseInt(document.getElementById('actingAs').value);
  refresh();
}

function renderSplitInputs() {
  const type = document.getElementById('splitType').value;
  const container = document.getElementById('splitInputs');
  if (type === 'equal') { container.innerHTML = ''; return; }
  const label = type === 'exact' ? 'amount' : '%';
  container.innerHTML = currentMembers.map(m =>
    `<div>${m.name}: <input type="number" step="0.01" class="splitInput" data-member="${m.id}" placeholder="${label}"></div>`
  ).join('');
}

async function addExpense() {
  const description = document.getElementById('desc').value;
  const amount = parseFloat(document.getElementById('amount').value);
  const paid_by = parseInt(document.getElementById('paidBy').value);
  const split_type = document.getElementById('splitType').value;
  let body = { description, amount, paid_by, split_type };
  if (split_type !== 'equal') {
    const key = split_type === 'exact' ? 'amount' : 'percent';
    body.splits = Array.from(document.querySelectorAll('.splitInput')).map(i => ({
      member_id: parseInt(i.dataset.member),
      [key]: parseFloat(i.value)
    }));
  }
  await fetch(`/groups/${groupId}/expenses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body)
  });
  await refresh();
}

async function downloadHistory() {
  const memberId = document.getElementById('historyMember').value;
  const res = await fetch(`/groups/${groupId}/members/${memberId}/history`, { headers: authHeaders() });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `history_${memberId}.csv`;
  a.click();
}

async function refresh() {
  if (actingAs === null) return;

  const group = await fetch(`/groups/${groupId}`, { headers: authHeaders() }).then(r => r.json());
  currentMembers = group.members;

  document.getElementById('memberList').innerHTML = currentMembers.map(m => `<li>${m.name}</li>`).join('');
  document.getElementById('paidBy').innerHTML = currentMembers.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  document.getElementById('historyMember').innerHTML = currentMembers.map(m => `<option value="${m.id}">${m.name}</option>`).join('');

  const actingSelect = document.getElementById('actingAs');
  actingSelect.innerHTML = currentMembers.map(m =>
    `<option value="${m.id}" ${m.id === actingAs ? 'selected' : ''}>${m.name}</option>`
  ).join('');

  renderSplitInputs();

  const balances = await fetch(`/groups/${groupId}/balances`, { headers: authHeaders() }).then(r => r.json());
  document.getElementById('balTable').innerHTML = balances.map(b =>
    `<tr><td>${b.name}</td><td>${(b.balance_cents / 100).toFixed(2)}</td></tr>`
  ).join('');

  const settle = await fetch(`/groups/${groupId}/settlement`, { headers: authHeaders() }).then(r => r.json());
  document.getElementById('settleList').innerHTML = settle.map(t =>
    `<li>${t.from} pays ${t.to}: ${(t.amount_cents / 100).toFixed(2)}</li>`
  ).join('');

  const activity = await fetch(`/groups/${groupId}/activity`, { headers: authHeaders() }).then(r => r.json());
  document.getElementById('feed').innerHTML = activity.expenses.map(e =>
    `<li>${e.paid_by_name} paid ${(e.amount_cents / 100).toFixed(2)} for "${e.description}" (${e.created_at})</li>`
  ).join('');
}