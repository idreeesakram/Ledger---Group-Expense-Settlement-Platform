// State
let state = {
  groupId: null,
  groupName: '',
  members: [],
  actingAsMemberId: null,
  balances: [],
  activity: { expenses: [], outstanding_settlements: [] }
};

// Formatting helpers
function formatMoney(cents) {
  return (cents / 100).toFixed(2);
}

function getInitials(name) {
  return name.substring(0, 2).toUpperCase();
}

// API Helpers
async function apiFetch(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  
  if (state.actingAsMemberId) {
    const member = state.members.find(m => m.id == state.actingAsMemberId);
    if (member && member.token) {
      headers['X-Member-Token'] = member.token;
    }
  }

  const res = await fetch(endpoint, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });

  if (!res.ok) {
    let err;
    try {
      const e = await res.json();
      err = e.error || 'API Error';
    } catch {
      err = `HTTP ${res.status}`;
    }
    throw new Error(err);
  }
  
  // if not CSV
  if (res.headers.get('Content-Type')?.includes('text/csv')) {
    return res.blob();
  }
  
  return res.json();
}

// DOM Elements
const els = {
  screenOnboarding: document.getElementById('screen-onboarding'),
  screenDashboard: document.getElementById('screen-dashboard'),
  formCreateGroup: document.getElementById('form-create-group'),
  inputGroupName: document.getElementById('input-group-name'),
  inputCreatorName: document.getElementById('input-creator-name'),
  inputCreatorBudget: document.getElementById('input-creator-budget'),
  groupTitle: document.getElementById('group-title'),
  actingAsSelect: document.getElementById('acting-as-select'),
  
  balancesList: document.getElementById('balances-list'),
  settlementsList: document.getElementById('settlements-list'),
  
  membersList: document.getElementById('members-list'),
  btnAddMemberText: document.getElementById('btn-add-member-text'),
  formAddMember: document.getElementById('form-add-member'),
  inputMemberName: document.getElementById('input-member-name'),
  inputMemberBudget: document.getElementById('input-member-budget'),
  btnCancelAddMember: document.getElementById('btn-cancel-add-member'),
  
  exportMemberSelect: document.getElementById('export-member-select'),
  btnDownloadCsv: document.getElementById('btn-download-csv'),
  
  activityFeed: document.getElementById('activity-feed'),
  btnAddExpense: document.getElementById('btn-add-expense'),
  
  modalAddExpense: document.getElementById('modal-add-expense'),
  btnCloseModal: document.getElementById('btn-close-modal'),
  formAddExpense: document.getElementById('form-add-expense'),
  expenseDesc: document.getElementById('expense-desc'),
  expenseAmount: document.getElementById('expense-amount'),
  expensePaidBy: document.getElementById('expense-paid-by'),
  splitDetails: document.getElementById('split-details'),
  splitRadios: document.querySelectorAll('input[name="split_type"]')
};

// Initialize
function init() {
  const savedGroupId = localStorage.getItem('ledger_groupId');
  const savedMembers = localStorage.getItem('ledger_members');
  
  if (savedGroupId && savedMembers) {
    state.groupId = savedGroupId;
    state.members = JSON.parse(savedMembers);
    if (state.members.length > 0) {
      state.actingAsMemberId = state.members[0].id;
    }
    loadDashboard();
  } else {
    showScreen('onboarding');
  }

  attachListeners();
}

function showScreen(screen) {
  els.screenOnboarding.classList.add('hidden');
  els.screenDashboard.classList.add('hidden');
  
  if (screen === 'onboarding') els.screenOnboarding.classList.remove('hidden');
  else if (screen === 'dashboard') els.screenDashboard.classList.remove('hidden');
}

// Actions
async function loadDashboard() {
  try {
    const group = await apiFetch(`/groups/${state.groupId}`);
    state.groupName = group.name;
    els.groupTitle.textContent = state.groupName;
    
    // Merge new members info with stored tokens
    const mergedMembers = group.members.map(apiM => {
      const storedM = state.members.find(m => m.id == apiM.id);
      return { ...apiM, token: storedM ? storedM.token : null };
    });
    state.members = mergedMembers;
    localStorage.setItem('ledger_members', JSON.stringify(state.members));
    
    if (!state.actingAsMemberId && state.members.length > 0) {
      state.actingAsMemberId = state.members[0].id;
    }

    refreshDashboardUI();
    showScreen('dashboard');
  } catch (err) {
    console.error(err);
    // If fail, probably invalid, clear and go to onboarding
    localStorage.removeItem('ledger_groupId');
    localStorage.removeItem('ledger_members');
    showScreen('onboarding');
  }
}

async function refreshDashboardUI() {
  if (state.members.length === 0) return;

  // Update dropdowns
  renderMemberSelect(els.actingAsSelect, state.actingAsMemberId);
  renderMemberSelect(els.expensePaidBy, state.actingAsMemberId);
  renderMemberSelect(els.exportMemberSelect, state.actingAsMemberId);
  
  // Render members list
  els.membersList.innerHTML = '';
  state.members.forEach(m => {
    const div = document.createElement('div');
    div.className = 'member-item';
    div.textContent = m.name;
    els.membersList.appendChild(div);
  });

  // Fetch balances and activity
  try {
    const [balances, activity] = await Promise.all([
      apiFetch(`/groups/${state.groupId}/balances`),
      apiFetch(`/groups/${state.groupId}/activity`)
    ]);
    
    state.balances = balances;
    state.activity = activity;
    
    renderBalances();
    renderSettlements();
    renderActivity();
  } catch (err) {
    console.error("Error refreshing dashboard", err);
  }
}

function renderMemberSelect(selectEl, selectedId) {
  selectEl.innerHTML = '';
  state.members.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    if (m.id == selectedId) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

function renderBalances() {
  els.balancesList.innerHTML = '';
  if (state.members.length === 0) {
    els.balancesList.innerHTML = `<div class="empty-state">No members yet</div>`;
    return;
  }

  // Find max absolute balance for scaling
  let maxAbs = 0;
  state.balances.forEach(b => {
    if (Math.abs(b.balance_cents) > maxAbs) maxAbs = Math.abs(b.balance_cents);
  });
  
  // Avoid division by zero
  if (maxAbs === 0) maxAbs = 1;

  state.balances.forEach(b => {
    const isPositive = b.balance_cents > 0;
    const isNegative = b.balance_cents < 0;
    const isZero = b.balance_cents === 0;
    const percent = (Math.abs(b.balance_cents) / maxAbs) * 100;
    
    let amountStr = formatMoney(Math.abs(b.balance_cents));
    let amountClass = 'zero';
    let sign = '';
    
    if (isPositive) { amountClass = 'positive'; sign = '+'; }
    if (isNegative) { amountClass = 'negative'; sign = '−'; } // Note: real minus sign
    
    const row = document.createElement('div');
    row.className = 'balance-row';
    
    row.innerHTML = `
      <div class="balance-name">${b.name}</div>
      <div class="balance-track-wrapper">
        <div class="balance-center-line"></div>
        <div class="balance-bar-container left">
          ${isNegative ? `<div class="balance-bar negative" style="width: ${percent}%"></div>` : ''}
        </div>
        <div class="balance-bar-container right">
          ${isPositive ? `<div class="balance-bar positive" style="width: ${percent}%"></div>` : ''}
        </div>
      </div>
      <div class="balance-amount mono ${amountClass}">${sign}$${amountStr}</div>
    `;
    els.balancesList.appendChild(row);
  });
}

function renderSettlements() {
  els.settlementsList.innerHTML = '';
  if (!state.activity.outstanding_settlements || state.activity.outstanding_settlements.length === 0) {
    els.settlementsList.innerHTML = `<div class="empty-state">All settled up!</div>`;
    return;
  }

  state.activity.outstanding_settlements.forEach(s => {
    const item = document.createElement('div');
    item.className = 'settlement-item';
    item.innerHTML = `
      <span>${s.from} &rarr; ${s.to}</span>
      <span class="settlement-amount mono">$${formatMoney(s.amount_cents)}</span>
    `;
    els.settlementsList.appendChild(item);
  });
}

function renderActivity() {
  els.activityFeed.innerHTML = '';
  if (!state.activity.expenses || state.activity.expenses.length === 0) {
    els.activityFeed.innerHTML = `<div class="empty-state">No expenses yet. Add your first one to get started.</div>`;
    return;
  }

  // Reverse to show newest first (assuming chronological from backend)
  const expenses = [...state.activity.expenses].reverse();

  expenses.forEach(e => {
    const dateStr = new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const card = document.createElement('div');
    card.className = 'expense-card';
    card.innerHTML = `
      <div class="expense-avatar">${getInitials(e.paid_by_name)}</div>
      <div class="expense-details">
        <div class="expense-desc">${e.description}</div>
        <div class="expense-meta">${e.paid_by_name} paid on ${dateStr}</div>
      </div>
      <div class="expense-amount mono">$${formatMoney(e.amount_cents)}</div>
    `;
    els.activityFeed.appendChild(card);
  });
}

function renderSplitDetails() {
  const type = document.querySelector('input[name="split_type"]:checked').value;
  if (type === 'equal') {
    els.splitDetails.classList.add('hidden');
    els.splitDetails.innerHTML = '';
    return;
  }
  
  els.splitDetails.classList.remove('hidden');
  els.splitDetails.innerHTML = '';
  
  state.members.forEach(m => {
    const row = document.createElement('div');
    row.className = 'split-row';
    row.innerHTML = `
      <span>${m.name}</span>
      <input type="number" class="mono split-input" data-member-id="${m.id}" placeholder="0" step="${type === 'exact' ? '0.01' : '1'}" min="0" required>
    `;
    els.splitDetails.appendChild(row);
  });
}

// Event Listeners
function attachListeners() {
  
  // Onboarding
  els.formCreateGroup.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = els.inputGroupName.value.trim();
    const creatorName = els.inputCreatorName.value.trim();
    const creatorBudget = parseFloat(els.inputCreatorBudget.value) || 0;
    if (!name || !creatorName) return;
    
    try {
      const g = await apiFetch('/groups', {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      
      state.groupId = g.id;
      localStorage.setItem('ledger_groupId', state.groupId);
      
      // Add first member as self
      const m = await apiFetch(`/groups/${g.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ name: creatorName, initial_budget: creatorBudget })
      });
      state.members.push(m);
      localStorage.setItem('ledger_members', JSON.stringify(state.members));
      state.actingAsMemberId = m.id;
      
      loadDashboard();
    } catch (err) {
      alert("Error creating group: " + err.message);
    }
  });

  // Dashboard - Acting As
  els.actingAsSelect.addEventListener('change', (e) => {
    state.actingAsMemberId = e.target.value;
    refreshDashboardUI(); // Refreshes with new token
  });

  // Dashboard - Add Member
  els.btnAddMemberText.addEventListener('click', () => {
    els.formAddMember.classList.remove('hidden');
    els.btnAddMemberText.classList.add('hidden');
    els.inputMemberName.focus();
  });
  
  els.btnCancelAddMember.addEventListener('click', () => {
    els.formAddMember.classList.add('hidden');
    els.btnAddMemberText.classList.remove('hidden');
    els.inputMemberName.value = '';
  });
  
  els.formAddMember.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = els.inputMemberName.value.trim();
    const budget = parseFloat(els.inputMemberBudget.value) || 0;
    if (!name) return;
    
    try {
      const m = await apiFetch(`/groups/${state.groupId}/members`, {
        method: 'POST',
        body: JSON.stringify({ name, initial_budget: budget })
      });
      state.members.push(m);
      localStorage.setItem('ledger_members', JSON.stringify(state.members));
      
      els.formAddMember.classList.add('hidden');
      els.btnAddMemberText.classList.remove('hidden');
      els.inputMemberName.value = '';
      
      refreshDashboardUI();
    } catch (err) {
      alert("Error adding member: " + err.message);
    }
  });

  // Export
  els.btnDownloadCsv.addEventListener('click', async () => {
    const mId = els.exportMemberSelect.value;
    if (!mId) return;
    
    try {
      const blob = await apiFetch(`/groups/${state.groupId}/members/${mId}/history`);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ledger_history.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      alert("Error exporting CSV: " + err.message);
    }
  });

  // Modal - Add Expense
  els.btnAddExpense.addEventListener('click', () => {
    if (state.members.length === 0) {
      alert("Add members first!");
      return;
    }
    els.formAddExpense.reset();
    els.modalAddExpense.classList.remove('hidden');
    renderSplitDetails(); // Reset split details UI
  });
  
  els.btnCloseModal.addEventListener('click', () => {
    els.modalAddExpense.classList.add('hidden');
  });

  els.splitRadios.forEach(r => {
    r.addEventListener('change', renderSplitDetails);
  });

  els.formAddExpense.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const desc = els.expenseDesc.value.trim();
    const amount = parseFloat(els.expenseAmount.value);
    const paidBy = els.expensePaidBy.value;
    const splitType = document.querySelector('input[name="split_type"]:checked').value;
    
    if (!desc || isNaN(amount) || !paidBy) return;

    let splits = undefined;
    
    if (splitType === 'exact' || splitType === 'percent') {
      splits = [];
      const inputs = els.splitDetails.querySelectorAll('.split-input');
      inputs.forEach(input => {
        const val = parseFloat(input.value);
        if (!isNaN(val)) {
          splits.push({
            member_id: input.dataset.memberId,
            [splitType === 'exact' ? 'amount' : 'percent']: val
          });
        }
      });
    }

    try {
      await apiFetch(`/groups/${state.groupId}/expenses`, {
        method: 'POST',
        body: JSON.stringify({
          description: desc,
          amount: amount,
          paid_by: paidBy,
          split_type: splitType,
          splits: splits
        })
      });
      
      els.modalAddExpense.classList.add('hidden');
      refreshDashboardUI();
    } catch (err) {
      alert("Error adding expense: " + err.message);
    }
  });
}

// Start
init();
