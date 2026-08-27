// =========================================================
// Admin Dashboard
// =========================================================

async function init() {
  const adminUser = await requireAdmin();
  if (!adminUser) return;

  initAdminShell('index.html', adminUser);

  await Promise.all([
    loadSummaryCards(),
    loadNewOneTimeBookings(),
    loadUpcomingMaintenanceBookings(),
    loadTodayBookings(),
  ]);

  document.getElementById('pageLoading').style.display = 'none';
  document.getElementById('pageContent').style.display = 'block';
}

async function loadSummaryCards() {
  const todayStr = toLocalDateStr(new Date());

  // 'pending' is kept in these status filters only so any historical
  // bookings/subscriptions created before automatic enrollment/booking
  // still surface here — new records go straight to active/confirmed.
  const [activeSubs, unpaidOneTime, todayBookings, upcomingBookings] = await Promise.all([
    supabaseClient.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabaseClient.from('one_time_bookings').select('id, payments(id)'),
    supabaseClient.from('bookings').select('id', { count: 'exact', head: true })
      .eq('requested_date', todayStr).in('status', ['pending', 'confirmed', 'rescheduled_by_admin']),
    supabaseClient.from('bookings').select('id', { count: 'exact', head: true })
      .gt('requested_date', todayStr).in('status', ['pending', 'confirmed', 'rescheduled_by_admin']),
  ]);

  const unpaidCount = (unpaidOneTime.data || []).filter(b => !b.payments || b.payments.length === 0).length;

  document.getElementById('cardActiveClients').textContent = activeSubs.count ?? 0;
  document.getElementById('cardPendingRequests').textContent = unpaidCount;
  document.getElementById('cardTodayBookings').textContent = todayBookings.count ?? 0;
  document.getElementById('cardUpcomingBookings').textContent = upcomingBookings.count ?? 0;
}

async function loadTodayBookings() {
  const todayStr = toLocalDateStr(new Date());

  const { data, error } = await supabaseClient
    .from('bookings')
    .select('*, subscriptions(vehicle_model, clients(full_name))')
    .eq('requested_date', todayStr)
    .order('requested_time', { ascending: true });

  const tbody = document.getElementById('todayBookingsBody');
  const emptyEl = document.getElementById('todayBookingsEmpty');
  const tableEl = document.getElementById('todayBookingsTable');

  if (error || !data || data.length === 0) {
    tableEl.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }

  tableEl.style.display = 'table';
  emptyEl.style.display = 'none';

  tbody.innerHTML = data.map(b => {
    const customerName = b.subscriptions?.clients?.full_name || '—';
    const vehicle = b.subscriptions?.vehicle_model || '—';
    return `
      <tr>
        <td>${b.confirmed_time || b.requested_time || '—'}</td>
        <td>${customerName}</td>
        <td>${vehicle}</td>
        <td>${visitTypeLabel(b.visit_type)}</td>
        <td>${badgeHtml(b.status)}</td>
      </tr>
    `;
  }).join('');
}

function visitTypeLabel(type) {
  const map = {
    deep_clean: 'Deep Clean',
    maintenance_wash: 'Maintenance Wash',
    mid_year_reset: 'Mid-Year Reset',
    bonus_perk: 'Bonus Perk',
  };
  return map[type] || type;
}

// Replaces the old "Pending Maintenance Requests" approval queue — new
// bookings are confirmed automatically (see book_maintenance_visit RPC),
// so admin no longer approves them. This panel is for visibility/
// management (view, reschedule, cancel, mark completed) instead.
async function loadUpcomingMaintenanceBookings() {
  const todayStr = toLocalDateStr(new Date());

  const { data, error } = await supabaseClient
    .from('bookings')
    .select('*, subscriptions(vehicle_model, clients(full_name))')
    .gte('requested_date', todayStr)
    .in('status', ['pending', 'confirmed', 'rescheduled_by_admin'])
    .order('requested_date', { ascending: true });

  const tbody = document.getElementById('pendingVisitsBody');
  const emptyEl = document.getElementById('pendingVisitsEmpty');
  const tableEl = document.getElementById('pendingVisitsTable');

  if (error || !data || data.length === 0) {
    tableEl.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }

  tableEl.style.display = 'table';
  emptyEl.style.display = 'none';

  tbody.innerHTML = data.map(b => {
    const customerName = b.subscriptions?.clients?.full_name || '—';
    const vehicle = b.subscriptions?.vehicle_model || '—';
    return `
      <tr>
        <td>${customerName}</td>
        <td>${vehicle}</td>
        <td>${formatDate(b.confirmed_date || b.requested_date)}</td>
        <td>${b.confirmed_time || b.requested_time || '—'}</td>
        <td>${badgeHtml(b.status)}</td>
        <td>
          <div class="btn-row">
            <button class="btn btn-primary btn-sm" data-complete-visit="${b.id}">Mark Completed</button>
            <button class="btn btn-danger btn-sm" data-cancel-visit="${b.id}">Cancel</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('[data-complete-visit]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Mark this booking as completed? This will count as one used wash for the customer.')) {
        updateVisitStatus(btn.dataset.completeVisit, 'completed', btn);
      }
    });
  });
  tbody.querySelectorAll('[data-cancel-visit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const note = prompt('Optional: add a reason the customer will see (e.g. "That slot is booked — please pick another date").', '');
      if (note === null) return; // user hit Cancel on the prompt itself
      updateVisitStatus(btn.dataset.cancelVisit, 'cancelled', btn, note);
    });
  });
}

async function loadNewOneTimeBookings() {
  const { data, error } = await supabaseClient
    .from('one_time_bookings')
    .select('*, payments(id)')
    .order('created_at', { ascending: false });

  const tbody = document.getElementById('newOnetimeBody');
  const emptyEl = document.getElementById('newOnetimeEmpty');
  const tableEl = document.getElementById('newOnetimeTable');

  // "New" = no payment recorded yet — matches the same needs-attention
  // logic as pending visits/maintenance requests, just keyed on payment
  // status instead of approval status.
  const unpaid = (data || []).filter(b => !b.payments || b.payments.length === 0);

  if (error || unpaid.length === 0) {
    tableEl.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }

  tableEl.style.display = 'table';
  emptyEl.style.display = 'none';

  tbody.innerHTML = unpaid.map(b => {
    const amount = b.calculated_price ? Number(b.calculated_price) : null;
    const actionHtml = amount
      ? `<button class="btn btn-success btn-sm" data-confirm-onetime-payment="${b.id}" data-amount="${amount}">Confirm Payment</button>`
      : `<a href="finances.html?pay_onetime=${b.id}" class="btn btn-outline btn-sm">Record Payment →</a>`;

    return `
      <tr>
        <td>${b.customer_name}</td>
        <td>${b.customer_phone}</td>
        <td>${b.service}</td>
        <td>${b.vehicle_model || '—'}${b.vehicle_type ? ' · ' + b.vehicle_type : ''}</td>
        <td>${amount ? '₹' + amount.toLocaleString('en-IN') : '—'}</td>
        <td>${formatDate(b.created_at)}</td>
        <td>${actionHtml}</td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('[data-confirm-onetime-payment]').forEach(btn => {
    btn.addEventListener('click', () => confirmOneTimePaymentFromDashboard(btn.dataset.confirmOnetimePayment, btn.dataset.amount, btn));
  });
}

async function confirmOneTimePaymentFromDashboard(bookingId, amount, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = 'Confirming…';

  const { error } = await supabaseClient.from('payments').insert({
    one_time_booking_id: bookingId,
    amount: Number(amount),
    payment_method: 'cash',
    payment_status: 'paid',
    payment_date: toLocalDateStr(new Date()),
  });

  if (error) {
    showToast('Failed to confirm payment: ' + error.message, 'error');
    btnEl.disabled = false;
    btnEl.textContent = 'Confirm Payment';
    return;
  }

  showToast('Payment confirmed — added to revenue.');
  await Promise.all([loadSummaryCards(), loadNewOneTimeBookings()]);
}

async function updateVisitStatus(bookingId, newStatus, btnEl, note) {
  btnEl.disabled = true;
  const updatePayload = { status: newStatus };
  if (note) updatePayload.admin_note = note;

  const { error } = await supabaseClient.from('bookings').update(updatePayload).eq('id', bookingId);

  if (error) {
    showToast('Failed to update: ' + error.message, 'error');
    btnEl.disabled = false;
    return;
  }

  const messages = {
    confirmed: 'Visit confirmed.',
    cancelled: 'Visit cancelled.',
    completed: 'Marked as completed — wash count updated.',
  };
  showToast(messages[newStatus] || 'Visit updated.');
  await Promise.all([loadSummaryCards(), loadUpcomingMaintenanceBookings(), loadTodayBookings()]);
}

// Membership enrollment is now automatic (see js/dashboard.js) — there is
// no longer a pending-subscription approval queue for admin to act on.
// approveSubscription()/rejectSubscription() were removed along with it.

document.addEventListener('DOMContentLoaded', init);
