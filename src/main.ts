import './style.css';
import { supabase, supabaseConfigured } from './supabase';
import QRCode from 'qrcode';
import { jsPDF } from 'jspdf';
import type { User } from '@supabase/supabase-js';

type Role = 'admin' | 'member';
type AuthView = 'login' | 'signup';
type Status = 'pending' | 'paid' | 'overdue';
interface Profile { id: string; index_number: string | null; full_name: string; phone: string | null; role: Role; organization_id: string | null; }
interface Due { id: string; title: string; amount: number; due_date: string; status: Status; member_id: string | null; index_numbers: string[]; profiles?: { index_number: string | null; full_name: string; phone: string | null } | { index_number: string | null; full_name: string; phone: string | null }[] | null; }
interface Payment { id: string; due_id: string; amount: number; status: string; refund_status?: string; refund_reason?: string | null; paystack_reference: string; paid_at: string | null; created_at: string; dues?: { title: string; due_date: string } | { title: string; due_date: string }[] | null; receipts?: { receipt_number: string } | { receipt_number: string }[] | null; profiles?: { index_number: string | null; full_name?: string | null } | { index_number: string | null; full_name?: string | null }[] | null; }
interface Ticket { id: string; due_id: string; event_name: string; ticket_type: 'single' | 'double' | 'vip'; capacity: number | null; cancelled_at?: string | null; description: string; image_url: string | null; index_numbers: string[]; dues?: Due | Due[] | null; }

let user: User | null = null;
let profile: Profile | null = null;
let authView: AuthView = 'login';
let selectedPage = 'Overview';
let loading = false;
let authRequestId = 0;
let adminPaymentSearch = '';
let adminPaymentStatus = 'all';
let adminPaymentFrom = '';
let adminPaymentTo = '';
const app = document.querySelector<HTMLDivElement>('#app')!;
const brandName = 'ElectionBridge';
const productName = 'ElectionBridge Dues';
const money = (value: number) => `GH₵${value.toLocaleString('en-GH')}`;
const date = (value: string) => new Date(value).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' });
const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
const initials = (name: string) => name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'GE';
const errorText = (error: unknown) => error instanceof Error ? error.message : (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : 'Something went wrong. Please try again.');
const authErrorText = (error: { message: string; code?: string; details?: string; hint?: string; status?: number }) => [error.message, error.status ? `HTTP: ${error.status}` : '', error.code ? `Code: ${error.code}` : '', error.details ? `Details: ${error.details}` : '', error.hint ? `Hint: ${error.hint}` : ''].filter(Boolean).join(' | ');
async function logAudit(action: string, entityType: string, entityId: string | null, details: Record<string, unknown> = {}) { if (!profile?.organization_id || !user) return; await supabase.from('audit_logs').insert({ organization_id: profile.organization_id, actor_id: user.id, action, entity_type: entityType, entity_id: entityId, details }); }

function configurationScreen() { app.innerHTML = `<main class="config-page"><div class="config-card"><div class="brand"><span class="brand-mark">E</span> ${brandName}</div><p class="eyebrow">Configuration required</p><h1>Connect your workspace.</h1><p>Add <strong>VITE_SUPABASE_URL</strong> and <strong>VITE_SUPABASE_ANON_KEY</strong> to your local <strong>.env</strong> file, then restart Vite.</p></div></main>`; }

function dashboardSkeleton() { app.innerHTML = '<main class="loading-page" aria-busy="true"><div class="loading-shell"><div class="skeleton skeleton-eyebrow"></div><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-copy"></div><div class="skeleton-grid"><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div></div><div class="skeleton skeleton-panel"></div></div></main>'; }

function onboardingScreen(message = '') {
  app.innerHTML = `<main class="config-page"><div class="config-card onboarding-card"><div class="brand"><span class="brand-mark">E</span> ${brandName}</div><p class="eyebrow">Association access</p><h1>Your account is pending access.</h1><p>This ${productName} account is not linked to the association yet. Ask the association administrator to confirm your account and index number.</p>${message ? `<div class="form-error">${esc(message)}</div>` : ''}<button class="text-button" id="onboarding-logout">Sign out</button></div></main>`;
  document.querySelector<HTMLButtonElement>('#onboarding-logout')!.onclick = logout;
}

function authScreen(message = '') {
  app.innerHTML = `<main class="auth-page"><section class="auth-showcase"><div class="brand auth-brand"><span class="brand-mark">G</span> GEODues</div><div class="auth-copy"><p class="eyebrow">The clear way to collect dues</p><h1>Every contribution.<br><em>Right on time.</em></h1><p>Secure student payments, receipts, and admin visibility for your institution.</p><div class="auth-proof"><span class="proof-mark">+</span><div><b>Built for your institution</b><small>Supabase security, Paystack checkout, and automatic receipts.</small></div></div></div><div class="auth-foot">GEODues <span>Secure payments</span></div></section><section class="auth-panel"><div class="auth-panel-inner"><div class="auth-tabs"><button class="${authView === 'login' ? 'active' : ''}" data-auth-view="login">Log in</button><button class="${authView === 'signup' ? 'active' : ''}" data-auth-view="signup">Create account</button></div><p class="eyebrow">${authView === 'login' ? 'Welcome back' : 'Create your account'}</p><h2>${authView === 'login' ? 'Sign in to GEODues' : 'Join GEODues'}</h2><p class="auth-subtitle">${authView === 'login' ? 'Your account determines the dashboard you can access.' : 'Your administrator will assign your institution access.'}</p>${message ? `<div class="form-error">${esc(message)}</div>` : ''}<form id="auth-form" class="auth-form">${authView === 'signup' ? '<label>Index number<input id="auth-index" type="text" placeholder="e.g. GEO/2026/001" required></label><label>Full name<input id="auth-name" type="text" placeholder="Your full name" required></label>' : ''}<label>Email address<input id="auth-email" type="email" placeholder="you@example.com" required></label><label>Password<input id="auth-password" type="password" placeholder="At least 8 characters" minlength="8" required></label>${authView === 'signup' ? '<label>Phone number<input id="auth-phone" type="tel" placeholder="+234 800 000 0000"></label>' : ''}<button class="primary-button auth-submit" type="submit">${authView === 'login' ? 'Continue to dashboard' : 'Create account'}</button></form>${authView === 'login' ? '<button class="text-button" id="forgot-password">Forgot password?</button>' : ''}<p class="auth-hint">${authView === 'login' ? 'Use the email assigned to your GEODues account.' : 'Your index number identifies your student account.'}</p><div class="auth-divider"><span>Protected by Supabase Auth</span></div><p class="auth-legal">By continuing, you agree to the GEODues terms and privacy policy.</p></div></section></main>`;
  document.querySelector<HTMLElement>('.auth-brand')!.innerHTML = `<span class="brand-mark">E</span> ${brandName}`;
  document.querySelector<HTMLElement>('.auth-foot')!.innerHTML = `${productName} <span>Powered by ${brandName}</span>`;
  document.querySelector<HTMLElement>('.auth-copy .eyebrow')!.textContent = 'A clearer way to manage contributions';
  document.querySelector<HTMLElement>('.auth-copy h1')!.innerHTML = 'Every contribution.<br><em>Connected.</em>';
  document.querySelector<HTMLElement>('.auth-copy > p:not(.eyebrow)')!.textContent = 'Simple dues collection, trusted payments, and a clear view of your association activity.';
  document.querySelector<HTMLElement>('.auth-proof b')!.textContent = `Powered by ${brandName}`;
  document.querySelector<HTMLElement>('.auth-proof small')!.textContent = 'Secure access, Paystack checkout, receipts, and admin visibility.';
  document.querySelector<HTMLElement>('.auth-panel-inner')!.insertAdjacentHTML('beforeend', `<a class="privacy-link" href="?privacy">Privacy policy</a>`);
  document.querySelectorAll<HTMLButtonElement>('[data-auth-view]').forEach((button) => button.onclick = () => { authView = button.dataset.authView as AuthView; authScreen(); });
  document.querySelector<HTMLButtonElement>('#forgot-password')?.addEventListener('click', async () => { const email = document.querySelector<HTMLInputElement>('#auth-email')?.value.trim(); if (!email) { authScreen('Enter your email address first, then choose forgot password.'); return; } const button = document.querySelector<HTMLButtonElement>('#forgot-password')!; button.disabled = true; button.textContent = 'Sending reset email...'; const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin }); authScreen(error ? `Password reset failed: ${error.message}` : 'Password reset instructions have been sent to your email.'); });
  const authForm = document.querySelector<HTMLFormElement>('#auth-form')!;
  authForm.oninvalid = () => authScreen('Complete all required fields before continuing.');
  authForm.onsubmit = async (event) => {
    event.preventDefault();
    if (loading) return;
    const requestId = ++authRequestId;
    const submitButton = document.querySelector<HTMLButtonElement>('.auth-submit');
    const email = document.querySelector<HTMLInputElement>('#auth-email')!.value.trim();
    const password = document.querySelector<HTMLInputElement>('#auth-password')!.value;
    const indexNumber = document.querySelector<HTMLInputElement>('#auth-index')?.value.trim() ?? '';
    const name = document.querySelector<HTMLInputElement>('#auth-name')?.value.trim() ?? '';
    const phone = document.querySelector<HTMLInputElement>('#auth-phone')?.value.trim() ?? '';
    loading = true;
    if (submitButton) submitButton.disabled = true;
    try {
      const result = authView === 'login'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password, options: { data: { index_number: indexNumber, full_name: name, phone } } });
      if (requestId !== authRequestId) return;
      if (result.error) { authScreen(authErrorText(result.error)); return; }
      if (authView === 'signup' && !result.data.session) { authScreen('Account created. Check your email to confirm, then log in.'); return; }
      await boot(result.data.user);
    } catch (error) {
      if (requestId === authRequestId) authScreen(errorText(error));
    } finally {
      if (requestId === authRequestId) loading = false;
    }
  };
}

async function readJsonResponse(response: Response): Promise<Record<string, any>> { const text = await response.text(); if (!text.trim()) return {}; try { const parsed: unknown = JSON.parse(text); return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : {}; } catch { return {}; } }

async function syncReturnedPayment() { const reference = new URLSearchParams(window.location.search).get('reference') || new URLSearchParams(window.location.search).get('trxref'); if (!reference) return; const localHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'; const verifyUrl = import.meta.env.VITE_PAYSTACK_VERIFY_URL || (localHost ? 'http://127.0.0.1:8080/php-api/paystack-verify.php' : '/api/paystack-verify'); const response = await fetch(verifyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference }) }); const result = await readJsonResponse(response) as { error?: string; status?: number; detail?: unknown; recorded?: boolean }; if (!response.ok) throw new Error([result.error || `Payment verification failed (HTTP ${response.status}).`, result.status ? `Status: ${result.status}` : '', result.detail ? `Detail: ${JSON.stringify(result.detail)}` : ''].filter(Boolean).join(' | ')); if (!result.recorded) throw new Error('Payment verification returned an empty response.'); window.history.replaceState({}, '', window.location.pathname); }

async function boot(currentUser: User | null) { user = currentUser; profile = null; if (!user) { authScreen(); return; } const { data, error } = await supabase.from('profiles').select('id, index_number, full_name, phone, role, organization_id').eq('id', user.id).single(); if (error) { authScreen(`Signed in, but your profile could not be loaded: ${error.message}`); return; } profile = data as Profile; if (!profile.organization_id) { onboardingScreen(); return; } let paymentError = ''; try { await syncReturnedPayment(); } catch (error) { console.error(error); paymentError = errorText(error); } selectedPage = profile.role === 'admin' ? 'Overview' : 'My overview'; await render(); if (paymentError) showPaymentModal('Payment not recorded', `<p class="modal-copy">${esc(paymentError)}</p><p class="modal-copy">Keep the Paystack reference in the URL and contact the administrator if this continues.</p>`); showPaymentQrFromUrl(); }

async function logout() { await supabase.auth.signOut(); user = null; profile = null; authView = 'login'; authScreen(); }

function privacyPage() { app.innerHTML = `<main class="legal-page"><div class="legal-shell"><a class="legal-brand" href="/"><span class="brand-mark">E</span>${brandName}</a><p class="eyebrow">Trust and transparency</p><h1>Privacy policy</h1><p class="legal-lead">This policy explains how ${brandName} handles information when you use ${productName}.</p><div class="legal-meta">Last updated: 19 September 2026</div><section class="legal-content"><h2>Information we collect</h2><p>We collect account details such as your name, email address, phone number, and association index number. We also process payment references and receipt information needed to confirm contributions.</p><h2>How we use information</h2><p>Information is used to provide secure account access, display dues, process payments through Paystack, issue receipts, prevent duplicate transactions, and support association administration.</p><h2>Payments</h2><p>Payment card and bank details are handled by Paystack. ${brandName} does not store your complete payment credentials. Payment status and transaction references may be retained for reconciliation and receipts.</p><h2>Storage and security</h2><p>Application data is stored with Supabase and protected with access controls. We limit access to information based on your role and the association workspace you belong to.</p><h2>Your choices</h2><p>You may ask your association administrator to correct account information or help with account access. You may also contact the service operator about privacy questions or deletion requests, subject to payment and legal recordkeeping requirements.</p><h2>Updates</h2><p>We may update this policy when the service changes. The latest version will always be available on this page.</p></section><a class="legal-back" href="/">Back to ${brandName}</a></div></main>`; }

function layout(content: string) { const isAdmin = profile?.role === 'admin'; const navItems = isAdmin ? ['Overview', 'Members', 'Dues', 'Payments', 'Reports'] : ['My overview', 'My dues', 'Payment history']; const displayName = profile?.full_name || user?.email || `${brandName} user`; app.innerHTML = `<div class="app-shell ${isAdmin ? 'admin-shell' : 'member-shell'}"><button class="mobile-menu-button" id="mobile-menu" aria-label="Open navigation">☰</button><div class="mobile-nav-backdrop" id="mobile-nav-backdrop"></div><aside class="sidebar" id="sidebar"><div class="brand"><span class="brand-mark">E</span> ${brandName}<button class="mobile-close-button" id="mobile-close" aria-label="Close navigation">×</button></div><div class="workspace-switcher">${esc(profile?.organization_id ? 'Institution workspace' : 'Pending institution')}<span>⌄</span></div><p class="nav-label">Workspace</p><nav class="nav">${navItems.map((item) => `<button class="${selectedPage === item ? 'active' : ''}" data-page="${item}">${item}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="profile"><span class="avatar">${initials(displayName)}</span><div><b>${esc(displayName)}</b><small>${isAdmin ? 'Institution admin' : 'Member account'}</small></div></div><button class="logout-button" id="logout">Log out</button></div></aside><main class="main">${content}</main></div>`; const closeMobileNav = () => document.querySelector('.app-shell')?.classList.remove('mobile-nav-open'); document.querySelector<HTMLButtonElement>('#mobile-menu')!.onclick = () => document.querySelector('.app-shell')?.classList.add('mobile-nav-open'); document.querySelector<HTMLButtonElement>('#mobile-close')!.onclick = closeMobileNav; document.querySelector<HTMLElement>('#mobile-nav-backdrop')!.onclick = closeMobileNav; document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((button) => button.onclick = () => { selectedPage = button.dataset.page ?? navItems[0]; closeMobileNav(); render(); }); document.querySelector<HTMLButtonElement>('#logout')!.onclick = logout; }

async function adminView() {
  const organizationId = profile?.organization_id;
  const [duesResult, membersResult] = await Promise.all([
    supabase.from('dues').select('id,title,amount,due_date,status,member_id,index_numbers,profiles(index_number,full_name,phone)').eq('organization_id', organizationId).order('due_date'),
    supabase.from('profiles').select('id,index_number,full_name,phone,role').eq('organization_id', organizationId).eq('role', 'member').order('index_number')
  ]);
  if (duesResult.error || membersResult.error) return layout(`<div class="state-message">${esc(errorText(duesResult.error || membersResult.error))}</div>`);
  const dues = (duesResult.data || []) as unknown as Due[];
  const members = membersResult.data || [];
  const ticketsResult = await supabase.from('tickets').select('due_id').eq('organization_id', organizationId);
  if (ticketsResult.error) return layout(`<div class="state-message">${esc(ticketsResult.error.message)}</div>`);
  const ticketDueIds = new Set((ticketsResult.data || []).map((ticket) => ticket.due_id as string));
  const regularDues = dues.filter((due) => !ticketDueIds.has(due.id));
  const memberName = (memberId: string) => { const member = members.find((item) => item.id === memberId); return member?.index_number || 'Unassigned'; };
  const paidByDue = new Map<string, number>();
  const memberRows = members.map((member) => `<tr><td>${esc(member.index_number || 'Not assigned')}</td><td>${esc(member.full_name || 'Unnamed member')}</td><td>${esc(member.phone || 'No phone')}</td><td><span class="badge paid">Active</span></td></tr>`).join('');
  const paymentsResult = await supabase.from('payments').select('id,due_id,amount,status,paystack_reference,paid_at,created_at,dues(title,due_date),receipts(receipt_number),profiles(index_number,full_name)').in('member_id', members.map((member) => member.id)).order('created_at', { ascending: false });
  if (paymentsResult.error) return layout(`<div class="state-message">${esc(paymentsResult.error.message)}</div>`);
  const ledgerPayments = (paymentsResult.data || []) as unknown as Payment[];
  ledgerPayments.filter((payment) => payment.status === 'paid').forEach((payment) => paidByDue.set(payment.due_id, (paidByDue.get(payment.due_id) || 0) + payment.amount));
  const dueRows = regularDues.map((due) => { const member = Array.isArray(due.profiles) ? due.profiles[0] : due.profiles; const outstanding = Math.max(0, due.amount - (paidByDue.get(due.id) || 0)); return `<tr><td>${esc(member?.index_number || (due.member_id ? memberName(due.member_id) : 'All members'))}</td><td>${esc(due.title)}</td><td>${date(due.due_date)}</td><td>${money(due.amount)}</td><td>${outstanding ? money(outstanding) : '<span class="badge paid">Paid in full</span>'}</td><td><span class="badge ${outstanding ? due.status : 'paid'}">${outstanding ? due.status : 'paid'}</span></td><td><button class="danger-button delete-due" data-due-id="${due.id}" type="button">Delete</button></td></tr>`; }).join('');
  let paymentRows = '<tr><td colspan="6">No payments recorded yet.</td></tr>';
  if (selectedPage === 'Payments') {
    const filteredPayments = ledgerPayments.filter((payment) => { const member = Array.isArray(payment.profiles) ? payment.profiles[0] : payment.profiles; const haystack = `${member?.index_number || ''} ${payment.paystack_reference}`.toLowerCase(); const paymentDate = (payment.paid_at || payment.created_at).slice(0, 10); return (!adminPaymentSearch || haystack.includes(adminPaymentSearch.toLowerCase())) && (adminPaymentStatus === 'all' || payment.status === adminPaymentStatus) && (!adminPaymentFrom || paymentDate >= adminPaymentFrom) && (!adminPaymentTo || paymentDate <= adminPaymentTo); });
    paymentRows = filteredPayments.map((payment) => { const due = Array.isArray(payment.dues) ? payment.dues[0] : payment.dues; const receipt = Array.isArray(payment.receipts) ? payment.receipts[0] : payment.receipts; const member = Array.isArray(payment.profiles) ? payment.profiles[0] : payment.profiles; const category = ticketDueIds.has(payment.due_id) ? 'TICKET' : 'DUE'; return `<tr><td><span class="badge ${category === 'TICKET' ? 'ticket-category' : 'due-category'}">${category}</span></td><td>${esc(member?.index_number || 'Unknown')}</td><td>${esc(payment.paystack_reference)}</td><td>${date(payment.paid_at || payment.created_at)}</td><td>${money(payment.amount)}</td><td><span class="badge ${payment.status === 'paid' ? 'paid' : 'pending'}">${esc(payment.status)}</span> ${receipt ? `<small class="receipt-number">${esc(receipt.receipt_number)}</small>` : ''}</td><td><button class="text-button admin-payment-details" data-payment-id="${payment.id}">Details</button><button class="text-button admin-payment-reconcile" data-payment-id="${payment.id}">Reconcile</button><button class="text-button admin-payment-receipt" data-payment-id="${payment.id}">PDF</button><button class="text-button admin-payment-qr" data-payment-id="${payment.id}">QR</button></td></tr>`; }).join('') || '<tr><td colspan="7">No payments match these filters.</td></tr>';
  }
  if (selectedPage === 'Create due') return createDueView(members);
  if (selectedPage === 'Create ticket') return createTicketView();
  const paid = ledgerPayments.filter((payment) => payment.status === 'paid' && !ticketDueIds.has(payment.due_id)).reduce((sum, payment) => sum + payment.amount, 0);
  const ticketRevenue = ledgerPayments.filter((payment) => payment.status === 'paid' && ticketDueIds.has(payment.due_id)).reduce((sum, payment) => sum + payment.amount, 0);
  const expected = regularDues.reduce((sum, due) => sum + due.amount, 0);
  const ticketDues = dues.filter((due) => ticketDueIds.has(due.id));
  const expectedTickets = ticketDues.reduce((sum, due) => sum + due.amount, 0);
  const paidDueCount = regularDues.filter((due) => (paidByDue.get(due.id) || 0) >= due.amount).length;
  const ticketSoldCount = ledgerPayments.filter((payment) => payment.status === 'paid' && ticketDueIds.has(payment.due_id)).length;
  const ticketUnitPrices = Array.from(new Set(ticketDues.map((due) => due.amount))).map((amount) => money(amount)).join(', ') || 'None';
  const paidDues = regularDues.filter((due) => (paidByDue.get(due.id) || 0) >= due.amount).length;
  const outstandingDues = regularDues.length - paidDues;
  const outstanding = Math.max(0, expected - paid);
  const assignedDueRows = regularDues.filter((due) => due.index_numbers?.length).map((due) => { const duePaid = paidByDue.get(due.id) || 0; const dueOutstanding = Math.max(0, due.amount - duePaid); return `<tr><td>${esc(due.title)}</td><td>${esc(due.index_numbers.join(', '))}</td><td>${date(due.due_date)}</td><td>${money(due.amount)}</td><td>${money(duePaid)}</td><td>${dueOutstanding ? money(dueOutstanding) : '<span class="badge paid">Paid in full</span>'}</td></tr>`; }).join('');
  const assignedDuesTable = `<div class="panel report-detail-panel"><div class="panel-heading"><h2>Dues assigned to index groups</h2></div><table class="table"><thead><tr><th>Due</th><th>Index numbers</th><th>Due date</th><th>Expected</th><th>Paid</th><th>Outstanding</th></tr></thead><tbody>${assignedDueRows || '<tr><td colspan="6">No dues are assigned to specific index groups yet.</td></tr>'}</tbody></table></div>`;
  const tableTitle = selectedPage === 'Members' ? 'Association members' : selectedPage === 'Payments' ? 'Payment ledger' : 'Dues schedule';
  const reportTable = `<div class="report-summary"><div class="stat"><p>Dues expected</p><strong>${money(expected)}</strong><small>${regularDues.length} due records</small></div><div class="stat"><p>Dues paid</p><strong>${money(paid)}</strong><small>${paidDueCount} fully paid</small></div><div class="stat"><p>Dues outstanding</p><strong>${money(outstanding)}</strong><small>${outstandingDues} unpaid</small></div><div class="stat"><p>Tickets sold</p><strong>${ticketSoldCount}</strong><small>${money(ticketRevenue)} revenue</small></div><div class="stat"><p>Ticket unit prices</p><strong>${esc(ticketUnitPrices)}</strong><small>${ticketDues.length} ticket offers</small></div><div class="stat"><p>Ticket value</p><strong>${money(expectedTickets)}</strong></div></div>${ledgerPayments.length ? '<p class="subtle">Reports separate ordinary dues from ticket revenue.</p>' : '<div class="state-message">No verified payments are available for reports yet.</div>'}`;
  const filters = selectedPage === 'Payments' ? `<div class="payment-filters"><input id="payment-search" placeholder="Search member or reference" value="${esc(adminPaymentSearch)}"><select id="payment-status"><option value="all" ${adminPaymentStatus === 'all' ? 'selected' : ''}>All statuses</option><option value="paid" ${adminPaymentStatus === 'paid' ? 'selected' : ''}>Paid</option><option value="pending" ${adminPaymentStatus === 'pending' ? 'selected' : ''}>Pending</option></select><label>From<input id="payment-from" type="date" value="${adminPaymentFrom}"></label><label>To<input id="payment-to" type="date" value="${adminPaymentTo}"></label><button class="ghost-button" id="export-payments">Export CSV</button><button class="ghost-button" id="scan-payment-qr">Scan QR</button></div>` : '';
  const table = selectedPage === 'Reports' ? `${reportTable}${assignedDuesTable}` : selectedPage === 'Members' ? `<table class="table"><thead><tr><th>Index number</th><th>Name</th><th>Phone</th><th>Account</th></tr></thead><tbody>${memberRows || '<tr><td colspan="4">No members have joined this association yet.</td></tr>'}</tbody></table>` : selectedPage === 'Payments' ? `${filters}<table class="table"><thead><tr><th>Category</th><th>Index number</th><th>Paystack reference</th><th>Date</th><th>Amount</th><th>Payment</th><th>QR</th></tr></thead><tbody>${paymentRows}</tbody></table>` : `<table class="table"><thead><tr><th>Index number</th><th>Description</th><th>Due date</th><th>Amount</th><th>Outstanding</th><th>Status</th><th>Actions</th></tr></thead><tbody>${dueRows || '<tr><td colspan="7">No dues created yet.</td></tr>'}</tbody></table>`;
  layout(`<header class="topbar"><div><p class="eyebrow">${esc(profile?.organization_id ? 'Association workspace' : 'GEODues')}</p><h1>${selectedPage === 'Overview' ? `Welcome, ${esc(profile?.full_name || 'admin')}.` : selectedPage}</h1><p class="subtle">Live association data from GEODues.</p></div><div class="top-actions"><button class="primary-button" id="new-due">+ Create due</button></div></header>${selectedPage === 'Overview' ? `<section class="stats"><div class="stat"><p>Dues paid</p><strong>${money(paid)}</strong><small>${paidDueCount} fully paid</small></div><div class="stat"><p>Dues expected</p><strong>${money(expected)}</strong><small>${regularDues.length} due records</small></div><div class="stat"><p>Dues outstanding</p><strong>${money(outstanding)}</strong><small>${outstandingDues} unpaid</small></div><div class="stat"><p>Tickets sold</p><strong>${ticketSoldCount}</strong><small>${money(ticketRevenue)} revenue</small></div><div class="stat"><p>Ticket unit prices</p><strong>${esc(ticketUnitPrices)}</strong><small>${ticketDues.length} offers</small></div></section>` : ''}<section class="panel"><div class="panel-heading"><h2>${tableTitle}</h2>${selectedPage !== 'Payments' && selectedPage !== 'Members' && selectedPage !== 'Reports' ? '<button class="primary-button" id="new-due-inline">+ Create due</button>' : ''}</div>${table}</section>`);
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#payment-search, #payment-status, #payment-from, #payment-to').forEach((control) => control.onchange = () => { adminPaymentSearch = document.querySelector<HTMLInputElement>('#payment-search')?.value || ''; adminPaymentStatus = document.querySelector<HTMLSelectElement>('#payment-status')?.value || 'all'; adminPaymentFrom = document.querySelector<HTMLInputElement>('#payment-from')?.value || ''; adminPaymentTo = document.querySelector<HTMLInputElement>('#payment-to')?.value || ''; void render(); });
  document.querySelectorAll<HTMLButtonElement>('#new-due, #new-due-inline').forEach((button) => button.onclick = () => { selectedPage = 'Create due'; render(); });
  document.querySelectorAll<HTMLButtonElement>('.delete-due').forEach((button) => button.onclick = async () => { const dueId = button.dataset.dueId; if (!dueId || !window.confirm('Delete this due? This cannot be undone.')) return; button.disabled = true; const { error } = await supabase.from('dues').delete().eq('id', dueId); if (error) { button.disabled = false; alert(error.message); return; } await render(); });
  document.querySelectorAll<HTMLButtonElement>('.admin-payment-qr').forEach((button) => button.onclick = () => { const payment = ledgerPayments.find((item) => item.id === button.dataset.paymentId); if (payment) showPaymentQr(payment); });
  document.querySelectorAll<HTMLButtonElement>('.admin-payment-details').forEach((button) => button.onclick = () => { const payment = ledgerPayments.find((item) => item.id === button.dataset.paymentId); if (payment) showPaymentDetails(payment); });
  document.querySelectorAll<HTMLButtonElement>('.admin-payment-reconcile').forEach((button) => button.onclick = async () => { const payment = ledgerPayments.find((item) => item.id === button.dataset.paymentId); if (!payment) return; button.disabled = true; try { const verifyUrl = import.meta.env.VITE_PAYSTACK_VERIFY_URL || 'http://127.0.0.1:8080/php-api/paystack-verify.php'; const response = await fetch(verifyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: payment.paystack_reference }) }); if (!response.ok) throw new Error((await response.json() as { error?: string }).error || 'Paystack verification failed.'); alert('Payment reconciled successfully.'); await render(); } catch (error) { button.disabled = false; alert(errorText(error)); } });
  document.querySelectorAll<HTMLButtonElement>('.admin-payment-receipt').forEach((button) => button.onclick = () => { const payment = ledgerPayments.find((item) => item.id === button.dataset.paymentId); if (payment) downloadReceipt(payment); });
  document.querySelector<HTMLButtonElement>('#export-payments')?.addEventListener('click', () => exportPayments(ledgerPayments));
  document.querySelector<HTMLButtonElement>('#scan-payment-qr')?.addEventListener('click', () => void scanPaymentQr());
}

function createDueView(members: Array<{ id: string; index_number: string | null; full_name: string }>) {
  layout(`<header class="topbar"><div><p class="eyebrow">Association workspace</p><h1>Create a due</h1><p class="subtle">Use separate dues when different index groups pay different amounts.</p></div></header><section class="panel form-panel"><form id="due-form" class="due-form"><label>Who should see this?<select id="due-member"><option value="all">All association members</option>${members.map((member) => `<option value="${member.id}">${esc(member.index_number || 'No index')} · ${esc(member.full_name)}</option>`).join('')}</select></label><label>Due title<input id="due-title" required placeholder="e.g. Annual association dues"></label><label>Amount in cedis<input id="due-amount" type="number" min="1" step="1" required placeholder="1500"></label><label>Due date<input id="due-date" type="date" required></label><div class="index-picker"><label for="due-index-search">Specific index numbers (optional)</label><input id="due-index-search" placeholder="Type an index prefix, e.g. GEO/2026"><label class="index-select-all"><input id="due-index-select-all" type="checkbox"> Select all matching indexes</label><div id="due-index-results" class="index-results"><span class="subtle">Start typing to find members.</span></div></div><div class="form-actions"><button type="button" class="ghost-button" id="cancel-due">Cancel</button><button type="submit" class="primary-button">Create due</button></div></form></section>`);
  document.querySelector<HTMLButtonElement>('#cancel-due')!.onclick = () => { selectedPage = 'Dues'; render(); };
  const renderIndexMatches = () => { const query = document.querySelector<HTMLInputElement>('#due-index-search')!.value.trim().toLowerCase(); const matches = members.filter((member) => member.index_number && member.index_number.toLowerCase().startsWith(query)); const result = document.querySelector<HTMLDivElement>('#due-index-results')!; result.innerHTML = query ? (matches.length ? matches.map((member) => `<label class="index-option"><input type="checkbox" class="due-index-option" value="${esc(member.index_number || '')}"> <span>${esc(member.index_number || '')}</span><small>${esc(member.full_name)}</small></label>`).join('') : '<span class="subtle">No matching index numbers.</span>') : '<span class="subtle">Start typing to find members.</span>'; document.querySelector<HTMLInputElement>('#due-index-select-all')!.checked = false; };
  document.querySelector<HTMLInputElement>('#due-index-search')!.addEventListener('input', renderIndexMatches);
  document.querySelector<HTMLInputElement>('#due-index-select-all')!.addEventListener('change', (event) => { const checked = (event.target as HTMLInputElement).checked; document.querySelectorAll<HTMLInputElement>('.due-index-option').forEach((input) => { input.checked = checked; }); });
  document.querySelector<HTMLFormElement>('#due-form')!.onsubmit = async (event) => { event.preventDefault(); const button = document.querySelector<HTMLButtonElement>('#due-form button[type="submit"]')!; button.disabled = true; const memberValue = document.querySelector<HTMLSelectElement>('#due-member')!.value; const indexes = Array.from(document.querySelectorAll<HTMLInputElement>('.due-index-option:checked')).map((input) => input.value); const { error } = await supabase.from('dues').insert({ organization_id: profile?.organization_id, member_id: memberValue === 'all' ? null : memberValue, title: document.querySelector<HTMLInputElement>('#due-title')!.value.trim(), amount: Number(document.querySelector<HTMLInputElement>('#due-amount')!.value), due_date: document.querySelector<HTMLInputElement>('#due-date')!.value, index_numbers: indexes }); if (error) { button.disabled = false; alert(error.message); return; } selectedPage = 'Dues'; render(); };
}

function createTicketView(existing?: Ticket) {
  const due = existing && (Array.isArray(existing.dues) ? existing.dues[0] : existing.dues);
  layout(`<header class="topbar"><div><p class="eyebrow">Association workspace</p><h1>${existing ? 'Edit an event ticket' : 'Create an event ticket'}</h1><p class="subtle">Tickets are optional and can target selected index numbers.</p></div></header><section class="panel form-panel"><form id="ticket-form" class="due-form"><label>Event name<input id="ticket-event" required value="${esc(existing?.event_name || '')}" placeholder="e.g. Awards night"></label><label>Ticket type<select id="ticket-type"><option value="single" ${existing?.ticket_type === 'single' ? 'selected' : ''}>Single</option><option value="double" ${existing?.ticket_type === 'double' ? 'selected' : ''}>Double</option><option value="vip" ${existing?.ticket_type === 'vip' ? 'selected' : ''}>VIP</option></select></label><label>Ticket capacity (optional)<input id="ticket-capacity" type="number" min="1" step="1" value="${existing?.capacity ?? ''}" placeholder="Leave blank for unlimited"></label><label>Description<textarea id="ticket-description" placeholder="Event details">${esc(existing?.description || '')}</textarea></label><label>Ticket image URL<input id="ticket-image" type="url" value="${esc(existing?.image_url || '')}" placeholder="https://..."></label><label>Price in cedis<input id="ticket-amount" type="number" min="1" step="1" required value="${due?.amount || ''}" placeholder="50"></label><label>Due date<input id="ticket-date" type="date" required value="${due?.due_date || ''}"></label><label>Index numbers (optional)<input id="ticket-indexes" value="${esc(existing?.index_numbers.join(', ') || '')}" placeholder="GEO/2026/001, GEO/2026/002"></label><label class="index-select-all"><input id="ticket-cancelled" type="checkbox" ${existing?.cancelled_at ? 'checked' : ''}> Ticket cancelled</label><div class="form-actions"><button type="button" class="ghost-button" id="cancel-ticket">Cancel</button><button type="submit" class="primary-button">${existing ? 'Save changes' : 'Create ticket'}</button></div></form></section>`);
  document.querySelector<HTMLButtonElement>('#cancel-ticket')!.onclick = () => { selectedPage = 'Tickets'; void render(); };
  document.querySelector<HTMLFormElement>('#ticket-form')!.onsubmit = async (event) => { event.preventDefault(); const button = document.querySelector<HTMLButtonElement>('#ticket-form button[type="submit"]')!; button.disabled = true; const eventName = document.querySelector<HTMLInputElement>('#ticket-event')!.value.trim(); const ticketType = document.querySelector<HTMLSelectElement>('#ticket-type')!.value; const capacityValue = document.querySelector<HTMLInputElement>('#ticket-capacity')!.value.trim(); const capacity = capacityValue ? Number(capacityValue) : null; const indexes = document.querySelector<HTMLInputElement>('#ticket-indexes')!.value.split(',').map((value) => value.trim()).filter(Boolean); const ticketData = { event_name: eventName, ticket_type: ticketType, capacity, description: document.querySelector<HTMLTextAreaElement>('#ticket-description')!.value.trim(), image_url: document.querySelector<HTMLInputElement>('#ticket-image')!.value.trim() || null, index_numbers: indexes, cancelled_at: document.querySelector<HTMLInputElement>('#ticket-cancelled')!.checked ? new Date().toISOString() : null }; if (existing) { const { error: dueError } = await supabase.from('dues').update({ title: `${ticketType.toUpperCase()} ticket: ${eventName}`, amount: Number(document.querySelector<HTMLInputElement>('#ticket-amount')!.value), due_date: document.querySelector<HTMLInputElement>('#ticket-date')!.value }).eq('id', existing.due_id); const { error } = await supabase.from('tickets').update(ticketData).eq('id', existing.id); if (dueError || error) { button.disabled = false; alert((dueError || error)?.message || 'Could not update ticket.'); return; } await logAudit('update', 'ticket', existing.id, { event_name: eventName }); } else { const { data: due, error: dueError } = await supabase.from('dues').insert({ organization_id: profile?.organization_id, member_id: null, title: `${ticketType.toUpperCase()} ticket: ${eventName}`, amount: Number(document.querySelector<HTMLInputElement>('#ticket-amount')!.value), due_date: document.querySelector<HTMLInputElement>('#ticket-date')!.value }).select('id').single(); if (dueError || !due) { button.disabled = false; alert(dueError?.message || 'Could not create ticket payment.'); return; } const { error } = await supabase.from('tickets').insert({ ...ticketData, organization_id: profile?.organization_id, due_id: due.id }); if (error) { await supabase.from('dues').delete().eq('id', due.id); button.disabled = false; alert(error.message); return; } await logAudit('create', 'ticket', null, { event_name: eventName }); } selectedPage = 'Tickets'; void render(); };
}

function showPaymentModal(title: string, content: string) {
  document.querySelector<HTMLElement>('.modal-backdrop')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><button class="modal-close" id="modal-close" aria-label="Close">x</button><p class="eyebrow">GEODues</p><h2>${title}</h2>${content}</section></div>`);
  document.querySelector<HTMLButtonElement>('#modal-close')!.onclick = () => document.querySelector<HTMLElement>('.modal-backdrop')?.remove();
}

function downloadReceipt(payment: Payment) {
  const due = Array.isArray(payment.dues) ? payment.dues[0] : payment.dues;
  const member = Array.isArray(payment.profiles) ? payment.profiles[0] : payment.profiles;
  const receipt = Array.isArray(payment.receipts) ? payment.receipts[0] : payment.receipts;
  const documentPdf = new jsPDF();
  documentPdf.setFontSize(20); documentPdf.text('GEODues payment receipt', 20, 25);
    documentPdf.setFontSize(11); documentPdf.text('Institution: GEODues institution workspace', 20, 42); documentPdf.text(`Member: ${member?.full_name || 'Member'} (${member?.index_number || 'No index'})`, 20, 52); documentPdf.text(`Description: ${due?.title || 'GEODues payment'}`, 20, 62); documentPdf.text(`Amount: ${money(payment.amount)}`, 20, 72); documentPdf.text(`Date and time: ${new Date(payment.paid_at || payment.created_at).toLocaleString()}`, 20, 82); documentPdf.text(`Paystack reference: ${payment.paystack_reference}`, 20, 92); documentPdf.text(`Receipt number: ${receipt?.receipt_number || 'Pending'}`, 20, 102);
  const qrPayload = paymentQrUrl(payment);
  QRCode.toDataURL(qrPayload, { width: 220, margin: 2 }).then((qr) => { documentPdf.addImage(qr, 'PNG', 20, 115, 55, 55); documentPdf.save(`geodues-receipt-${receipt?.receipt_number || payment.paystack_reference}.pdf`); }).catch(() => documentPdf.save(`geodues-receipt-${receipt?.receipt_number || payment.paystack_reference}.pdf`));
}

function paymentQrUrl(payment: Payment): string {
  const due = Array.isArray(payment.dues) ? payment.dues[0] : payment.dues;
  const member = Array.isArray(payment.profiles) ? payment.profiles[0] : payment.profiles;
  const receipt = Array.isArray(payment.receipts) ? payment.receipts[0] : payment.receipts;
  const payload = JSON.stringify({ type: 'GEODues payment', reference: payment.paystack_reference, member: member?.index_number || profile?.index_number || 'Unknown', due: due?.title || 'GEODues payment', amount: money(payment.amount), paid_at: payment.paid_at || payment.created_at, receipt: receipt?.receipt_number || 'Pending' });
  return `${window.location.origin}/?payment_qr=${encodeURIComponent(payload)}`;
}

function showPaymentDetails(payment: Payment) { const due = Array.isArray(payment.dues) ? payment.dues[0] : payment.dues; const receipt = Array.isArray(payment.receipts) ? payment.receipts[0] : payment.receipts; const member = Array.isArray(payment.profiles) ? payment.profiles[0] : payment.profiles; showPaymentModal('Payment details', `<p class="modal-copy">Member: <strong>${esc(member?.index_number || 'Unknown')}</strong><br>Due: <strong>${esc(due?.title || 'Payment')}</strong><br>Amount: <strong>${money(payment.amount)}</strong><br>Time: <strong>${esc(new Date(payment.paid_at || payment.created_at).toLocaleString())}</strong><br>Reference: <strong>${esc(payment.paystack_reference)}</strong><br>Receipt: <strong>${esc(receipt?.receipt_number || 'Pending')}</strong></p><button class="primary-button" id="detail-receipt">Download PDF receipt</button>`); document.querySelector<HTMLButtonElement>('#detail-receipt')!.onclick = () => downloadReceipt(payment); }

function exportPayments(payments: Payment[]) { const rows = [['Member', 'Reference', 'Due', 'Amount', 'Status', 'Paid at', 'Receipt number'], ...payments.map((payment) => { const due = Array.isArray(payment.dues) ? payment.dues[0] : payment.dues; const receipt = Array.isArray(payment.receipts) ? payment.receipts[0] : payment.receipts; const member = Array.isArray(payment.profiles) ? payment.profiles[0] : payment.profiles; return [member?.index_number || '', payment.paystack_reference, due?.title || '', String(payment.amount), payment.status, payment.paid_at || payment.created_at, receipt?.receipt_number || '']; })]; const csv = rows.map((row) => row.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')).join('\n'); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = 'geodues-payments.csv'; link.click(); URL.revokeObjectURL(link.href); }

function showScannedPayment(rawValue: string) {
  try {
    let paymentValue = rawValue;
    try { const scannedUrl = new URL(rawValue); paymentValue = scannedUrl.searchParams.get('ticket_qr') || scannedUrl.searchParams.get('payment_qr') || rawValue; } catch { /* Legacy QR payload. */ }
    const payment = JSON.parse(decodeURIComponent(paymentValue)) as { member?: string; index_number?: string; event?: string; ticket_type?: string; due?: string; amount?: string; paid_at?: string; reference?: string; receipt?: string; status?: string; type?: string };
    if (!payment.reference || !['GEODues payment', 'GEODues ticket badge'].includes(payment.type || '')) throw new Error('This is not a GEODues payment or ticket QR code.');
    const detailPage = payment.type === 'GEODues ticket badge'
      ? `<header class="topbar"><div><p class="eyebrow">Entry verification</p><h1>Ticket holder details</h1><p class="subtle">Scan result for event admission.</p></div></header><section class="verification-page"><div class="verification-status">${esc(payment.status || 'CONFIRMED')}</div><h2>${esc(payment.member || 'Member')}</h2><p class="verification-index">${esc(payment.index_number || 'No index number')}</p><div class="verification-grid"><div><small>Event</small><strong>${esc(payment.event || 'Event ticket')}</strong></div><div><small>Ticket type</small><strong>${esc(payment.ticket_type || 'Ticket')}</strong></div><div><small>Amount paid</small><strong>${esc(payment.amount || 'Unknown')}</strong></div><div><small>Paid at</small><strong>${esc(payment.paid_at ? new Date(payment.paid_at).toLocaleString() : 'Unknown')}</strong></div><div><small>Status</small><strong>${esc(payment.status || 'CONFIRMED')}</strong></div><div><small>Reference</small><strong>${esc(payment.reference)}</strong></div></div><button class="ghost-button" id="verification-back">Back to dashboard</button></section>`
      : `<header class="topbar"><div><p class="eyebrow">Payment verification</p><h1>Payment details</h1><p class="subtle">Scan result.</p></div></header><section class="verification-page"><div class="verification-status">VERIFIED</div><h2>${esc(payment.member || 'Member')}</h2><div class="verification-grid"><div><small>Due</small><strong>${esc(payment.due || 'Payment')}</strong></div><div><small>Amount</small><strong>${esc(payment.amount || 'Unknown')}</strong></div><div><small>Paid at</small><strong>${esc(payment.paid_at ? new Date(payment.paid_at).toLocaleString() : 'Unknown')}</strong></div><div><small>Receipt</small><strong>${esc(payment.receipt || 'Pending')}</strong></div><div><small>Reference</small><strong>${esc(payment.reference)}</strong></div></div><button class="ghost-button" id="verification-back">Back to dashboard</button></section>`;
    document.querySelector<HTMLElement>('.modal-backdrop')?.remove();
    layout(detailPage);
    document.querySelector<HTMLButtonElement>('#verification-back')!.onclick = () => { selectedPage = profile?.role === 'admin' ? 'Payments' : 'My overview'; void render(); };
  } catch (error) {
    document.querySelector<HTMLElement>('.modal-backdrop')?.remove();
    layout(`<header class="topbar"><div><p class="eyebrow">Entry verification</p><h1>Invalid QR code</h1></div></header><section class="verification-page"><div class="verification-status verification-invalid">INVALID</div><p class="modal-copy">${esc(errorText(error))}</p><button class="ghost-button" id="verification-back">Back to dashboard</button></section>`);
    document.querySelector<HTMLButtonElement>('#verification-back')!.onclick = () => { selectedPage = profile?.role === 'admin' ? 'Payments' : 'My overview'; void render(); };
  }
}

async function scanPaymentQr() { if (!('BarcodeDetector' in window)) { showPaymentModal('QR scanner unavailable', '<p class="modal-copy">This browser does not support camera QR scanning. Use the QR button on a payment row instead.</p>'); return; } showPaymentModal('Scan payment QR', '<video id="qr-video" class="qr-video" autoplay playsinline></video><p id="qr-scan-status" class="modal-copy">Point the camera at a payment QR code.</p>'); const video = document.querySelector<HTMLVideoElement>('#qr-video')!; const detector = new (window as Window & { BarcodeDetector: new (options: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector({ formats: ['qr_code'] }); const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); video.srcObject = stream; const scan = async () => { const codes = await detector.detect(video); if (codes[0]) { stream.getTracks().forEach((track) => track.stop()); showScannedPayment(codes[0].rawValue); return; } window.requestAnimationFrame(() => void scan()); }; void scan(); }

function hasPublicPaymentQr() { const params = new URLSearchParams(window.location.search); return Boolean(params.get('ticket_qr') || params.get('payment_qr')); }
function showPaymentQrFromUrl() { const params = new URLSearchParams(window.location.search); const qr = params.get('ticket_qr') || params.get('payment_qr'); if (!qr) return; showScannedPayment(qr); window.history.replaceState({}, '', window.location.pathname); }

function showPaymentQr(payment: Payment) {
  const due = Array.isArray(payment.dues) ? payment.dues[0] : payment.dues;
  const receipt = Array.isArray(payment.receipts) ? payment.receipts[0] : payment.receipts;
  const member = Array.isArray(payment.profiles) ? payment.profiles[0] : payment.profiles;
  const payload = JSON.stringify({ type: 'GEODues payment', reference: payment.paystack_reference, member: member?.index_number || profile?.index_number || 'Unknown', due: due?.title || 'GEODues payment', amount: money(payment.amount), paid_at: payment.paid_at || payment.created_at, receipt: receipt?.receipt_number || 'Pending' });
  showPaymentModal('Payment QR code', `<p class="modal-copy">Admin can scan this code to view the payment reference, member, amount, time, and receipt.</p><canvas id="payment-qr" class="payment-qr"></canvas><button class="primary-button" id="download-payment-qr">Download QR</button>`);
  const canvas = document.querySelector<HTMLCanvasElement>('#payment-qr');
  if (!canvas) return;
  QRCode.toCanvas(canvas, `${window.location.origin}/?payment_qr=${encodeURIComponent(payload)}`, { width: 240, margin: 2 }).catch((error: unknown) => { canvas.insertAdjacentHTML('afterend', `<p class="form-error">${esc(errorText(error))}</p>`); });
  document.querySelector<HTMLButtonElement>('#download-payment-qr')!.onclick = () => { const link = document.createElement('a'); link.href = canvas.toDataURL('image/png'); link.download = `geodues-${payment.paystack_reference}-qr.png`; link.click(); };
}

function openDuePayment(due: Due, remaining: number) {
  if (remaining <= 0) { showPaymentModal('Due fully paid', `<p class="modal-copy">${esc(due.title)} has already been paid in full. No further payment is required.</p>`); return; }
  showPaymentModal(`Pay ${esc(due.title)}`, `<p class="modal-copy">Remaining balance: <strong>${money(remaining)}</strong></p><label class="modal-label">Amount to pay<input id="part-payment-amount" type="number" min="1" max="${remaining}" step="1" value="${remaining}"></label><button class="primary-button" id="confirm-part-payment">Continue to Paystack</button>`);
  document.querySelector<HTMLButtonElement>('#confirm-part-payment')!.onclick = () => { const amount = Number(document.querySelector<HTMLInputElement>('#part-payment-amount')!.value); if (!Number.isInteger(amount) || amount < 1 || amount > remaining) { alert(`Enter an amount between 1 and ${remaining}.`); return; } document.querySelector<HTMLElement>('.modal-backdrop')?.remove(); void startPaystack(due, amount); };
}

async function memberViewWithSections() {
  const { data: dues = [], error } = await supabase.from('dues').select('id,title,amount,due_date,status,member_id,index_numbers').eq('organization_id', profile?.organization_id).order('due_date');
  if (error) return layout(`<div class="state-message">${esc(error.message)}</div>`);
  const { data: payments = [], error: paymentError } = await supabase.from('payments').select('id,due_id,amount,status,paystack_reference,paid_at,created_at,dues(title,due_date),receipts(receipt_number)').eq('member_id', user?.id).order('created_at', { ascending: false });
  if (paymentError) return layout(`<div class="state-message">${esc(paymentError.message)}</div>`);
  const typedDues = (dues as Due[]).filter((due) => due.member_id === user?.id || (due.member_id === null && ((!due.index_numbers || due.index_numbers.length === 0) || due.index_numbers.includes(profile?.index_number || '')))); const typedPayments = payments as unknown as Payment[]; const paidByDue = new Map<string, number>();
  typedPayments.filter((payment) => payment.status === 'paid').forEach((payment) => paidByDue.set(payment.due_id, (paidByDue.get(payment.due_id) || 0) + payment.amount));
  const balance = (due: Due) => Math.max(0, due.amount - (paidByDue.get(due.id) || 0)); const mine = typedDues.find((due) => balance(due) > 0);
  const history = typedPayments.map((payment) => { const due = Array.isArray(payment.dues) ? payment.dues[0] : payment.dues; const receipt = Array.isArray(payment.receipts) ? payment.receipts[0] : payment.receipts; return `<tr><td>${esc(due?.title || 'GEODues payment')}</td><td>${date(payment.paid_at || payment.created_at)}</td><td>${money(payment.amount)}</td><td><span class="badge ${payment.status === 'paid' ? 'paid' : 'pending'}">${esc(payment.status)}</span>${receipt ? `<small class="receipt-number">${esc(receipt.receipt_number)}</small>` : ''}</td><td><button class="text-button download-receipt" data-payment-id="${payment.id}">Receipt</button><button class="text-button show-payment-qr" data-payment-id="${payment.id}">QR</button></td></tr>`; }).join('');
  const dueRows = typedDues.map((due) => `<tr><td>${esc(due.title)}</td><td>${date(due.due_date)}</td><td>${money(due.amount)}</td><td>${balance(due) ? money(balance(due)) : '<span class="badge paid">Paid in full</span>'}</td><td><button class="primary-button pay-due" data-due-id="${due.id}">${balance(due) ? `Pay ${money(balance(due))}` : 'View status'}</button></td></tr>`).join('');
  const header = `<header class="topbar"><div><p class="eyebrow">Index number / ${esc(profile?.index_number || 'Not assigned')}</p><h1>${selectedPage === 'My dues' ? 'My dues' : selectedPage === 'Payment history' ? 'Payment history' : `Welcome, ${esc(profile?.index_number || 'student')}.`}</h1><p class="subtle">Your dues and receipts, all in one place.</p></div></header>`;
  const overview = mine ? `<section class="member-hero"><div><p class="eyebrow">Next payment</p><h2>${esc(mine.title)}</h2><p>Remaining ${money(balance(mine))} of ${money(mine.amount)}.</p></div><button class="primary-button pay-due" data-due-id="${mine.id}">Pay ${money(balance(mine))}</button></section>` : '<div class="state-message">All assigned dues are paid in full.</div>';
  const duesPanel = `<section class="panel"><div class="panel-heading"><h2>My dues</h2></div><table class="table"><thead><tr><th>Description</th><th>Due date</th><th>Total</th><th>Remaining</th><th>Action</th></tr></thead><tbody>${dueRows || '<tr><td colspan="5">No dues assigned yet.</td></tr>'}</tbody></table></section>`;
  const historyPanel = `<section class="panel"><div class="panel-heading"><h2>Payment history</h2></div><table class="table"><thead><tr><th>Description</th><th>Payment date</th><th>Amount</th><th>Status / receipt</th><th>Receipt</th></tr></thead><tbody>${history || '<tr><td colspan="5">No payments recorded yet.</td></tr>'}</tbody></table></section>`;
  layout(`${header}${selectedPage === 'My dues' ? duesPanel : selectedPage === 'Payment history' ? historyPanel : `${overview}${historyPanel}`}`);
  document.querySelectorAll<HTMLButtonElement>('.pay-due').forEach((button) => button.onclick = () => { const due = typedDues.find((item) => item.id === button.dataset.dueId); if (due) openDuePayment(due, balance(due)); });
  document.querySelectorAll<HTMLButtonElement>('.download-receipt').forEach((button) => button.onclick = () => { const payment = typedPayments.find((item) => item.id === button.dataset.paymentId); if (payment) downloadReceipt(payment); });
  document.querySelectorAll<HTMLButtonElement>('.show-payment-qr').forEach((button) => button.onclick = () => { const payment = typedPayments.find((item) => item.id === button.dataset.paymentId); if (payment) showPaymentQr(payment); });
}
async function startPaystack(due: Due, amount: number) {
  const payButton = document.querySelector<HTMLButtonElement>('#pay-now');
  if (!user?.email || !profile) { alert('Your account profile is not ready. Refresh and try again.'); return; }
  if (payButton) { payButton.disabled = true; payButton.textContent = 'Opening checkout...'; }
  try {
    const reference = `GEODUES-${crypto.randomUUID()}`;
    const localHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const initializeUrl = import.meta.env.VITE_PAYSTACK_INITIALIZE_URL || (localHost ? 'http://127.0.0.1:8080/php-api/paystack-initialize.php' : '/api/paystack-initialize');
    const response = await fetch(initializeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, amount: amount * 100, reference, callback_url: window.location.origin, metadata: { member_id: user.id, due_id: due.id, member_phone: profile.phone, index_number: profile.index_number } }) });
    const initialized = await readJsonResponse(response) as { authorization_url?: string; error?: string };
    if (!response.ok || !initialized.authorization_url) throw new Error(initialized.error || 'Paystack could not initialize the checkout.');
    window.location.assign(initialized.authorization_url);
  } catch (error) {
    if (payButton) { payButton.disabled = false; payButton.textContent = `Pay ${money(amount)}`; }
    alert(errorText(error));
  }
}


async function ticketDashboard() {
  const { data, error } = await supabase.from('tickets').select('id,due_id,event_name,ticket_type,capacity,cancelled_at,description,image_url,index_numbers,dues(id,title,amount,due_date,status,member_id)').eq('organization_id', profile?.organization_id).order('created_at', { ascending: false });
  if (error) return layout(`<div class="state-message">${esc(error.message)}</div>`);
  const tickets = (data || []) as unknown as Ticket[];
  const ticketDueIds = tickets.map((ticket) => ticket.due_id);
  const { data: ticketPayments = [] } = ticketDueIds.length ? await supabase.from('payments').select('due_id,member_id,status').in('due_id', ticketDueIds).eq('status', 'paid') : { data: [] };
  const soldByDue = new Map<string, number>();
  (ticketPayments || []).forEach((payment) => soldByDue.set(payment.due_id, (soldByDue.get(payment.due_id) || 0) + 1));
  const ticketCards = tickets.map((ticket) => {
    const due = Array.isArray(ticket.dues) ? ticket.dues[0] : ticket.dues;
    const sold = soldByDue.get(ticket.due_id) || 0;
    const soldOut = ticket.capacity !== null && sold >= ticket.capacity;
    return `<article class="ticket-card ${ticket.cancelled_at ? 'ticket-cancelled' : ''}">${ticket.image_url ? `<img src="${esc(ticket.image_url)}" alt="${esc(ticket.event_name)}">` : '<div class="ticket-card-placeholder">EVENT TICKET</div>'}<div class="ticket-card-body"><p class="eyebrow">${esc(ticket.ticket_type.toUpperCase())} · ${esc(ticket.index_numbers.length ? `For ${ticket.index_numbers.join(', ')}` : 'Open to all members')}</p><h2>${esc(ticket.event_name)}</h2><p>${esc(ticket.description || 'Event ticket')}</p><strong>${money(due?.amount || 0)}</strong><small>${sold}${ticket.capacity !== null ? ` of ${ticket.capacity}` : ''} sold</small>${profile?.role === 'admin' ? `<button class="ghost-button edit-ticket" data-ticket-id="${ticket.id}">Edit ticket</button>${ticket.cancelled_at ? '<span class="badge pending">Cancelled</span>' : '<span class="subtle">Admin view only</span>'}` : ticket.cancelled_at ? '<span class="badge pending">Cancelled</span>' : soldOut ? '<span class="badge pending">Sold out</span>' : `<button class="primary-button ticket-pay" data-due-id="${ticket.due_id}">Get ticket</button>`}</div></article>`;
  }).join('');
  layout(`<header class="topbar"><div><p class="eyebrow">Events</p><h1>Tickets</h1><p class="subtle">Optional event tickets available for your index number.</p></div>${profile?.role === 'admin' ? '<div class="top-actions"><button class="primary-button" id="new-ticket-dashboard">+ Create ticket</button></div>' : ''}</header><section class="ticket-grid">${ticketCards || '<div class="state-message">No event tickets are available yet.</div>'}</section>`);
  document.querySelectorAll<HTMLButtonElement>('.ticket-pay').forEach((button) => button.onclick = async () => { const ticket = tickets.find((item) => item.due_id === button.dataset.dueId); const due = ticket && (Array.isArray(ticket.dues) ? ticket.dues[0] : ticket.dues); if (!ticket || !due) return; if (ticket.capacity !== null && (soldByDue.get(ticket.due_id) || 0) >= ticket.capacity) { alert('This ticket is sold out.'); return; } const { data: existing } = await supabase.from('payments').select('id').eq('due_id', ticket.due_id).eq('member_id', user?.id).eq('status', 'paid').limit(1); if (existing?.length) { alert('You have already purchased this ticket. Open Tickets bought to view it.'); return; } openDuePayment(due, due.amount); });
  document.querySelector<HTMLButtonElement>('#new-ticket-dashboard')?.addEventListener('click', () => { selectedPage = 'Create ticket'; createTicketView(); });
  document.querySelectorAll<HTMLButtonElement>('.edit-ticket').forEach((button) => button.onclick = () => { const ticket = tickets.find((item) => item.id === button.dataset.ticketId); if (ticket) createTicketView(ticket); });
}

function showTicketBadgeQr(payment: Payment, ticket: Ticket) {
  const member = Array.isArray(payment.profiles) ? payment.profiles[0] : payment.profiles;
  const payload = JSON.stringify({ type: 'GEODues ticket badge', status: 'CONFIRMED', event: ticket.event_name, ticket_type: ticket.ticket_type, member: member?.full_name || 'Member', index_number: member?.index_number || 'Not assigned', amount: money(payment.amount), paid_at: payment.paid_at || payment.created_at, reference: payment.paystack_reference });
  showPaymentModal('Confirmed ticket badge', `<p class="modal-copy">Show this QR code at the event entrance.</p><div class="ticket-badge"><strong>CONFIRMED</strong><span>${esc(ticket.event_name)}</span><small>${esc(member?.full_name || 'Member')} · ${esc(member?.index_number || 'No index')}</small></div><canvas id="ticket-badge-qr" class="payment-qr"></canvas>`);
  const canvas = document.querySelector<HTMLCanvasElement>('#ticket-badge-qr');
  if (canvas) QRCode.toCanvas(canvas, `${window.location.origin}/?ticket_qr=${encodeURIComponent(payload)}`, { width: 240, margin: 2 }).catch((error: unknown) => canvas.insertAdjacentHTML('afterend', `<p class="form-error">${esc(errorText(error))}</p>`));
}

async function ticketRevenueDashboard() {
  const { data: tickets = [], error: ticketError } = await supabase.from('tickets').select('id,due_id,event_name,ticket_type,capacity,description,image_url,index_numbers,dues(id,title,amount,due_date,status,member_id)').eq('organization_id', profile?.organization_id).order('created_at', { ascending: false });
  if (ticketError) return layout(`<div class="state-message">${esc(ticketError.message)}</div>`);
  const typedTickets = tickets as unknown as Ticket[];
  const dueIds = typedTickets.map((ticket) => ticket.due_id);
  const { data: payments = [], error: paymentError } = dueIds.length ? await supabase.from('payments').select('id,due_id,amount,status,refund_status,refund_reason,paystack_reference,paid_at,created_at,profiles(index_number,full_name),dues(title,due_date),receipts(receipt_number)').in('due_id', dueIds).order('created_at', { ascending: false }) : { data: [], error: null };
  if (paymentError) return layout(`<div class="state-message">${esc(paymentError.message)}</div>`);
  const paidPayments = (payments as unknown as Payment[]).filter((payment) => payment.status === 'paid');
  const rows = paidPayments.map((payment) => { const ticket = typedTickets.find((item) => item.due_id === payment.due_id); const member = Array.isArray(payment.profiles) ? payment.profiles[0] : payment.profiles; const receipt = Array.isArray(payment.receipts) ? payment.receipts[0] : payment.receipts; return `<tr><td>${esc(member?.index_number || 'No index')}</td><td>${esc(member?.full_name || 'Member')}</td><td>${esc(ticket?.event_name || 'Event ticket')}</td><td>${money(payment.amount)}</td><td>${date(payment.paid_at || payment.created_at)} ${new Date(payment.paid_at || payment.created_at).toLocaleTimeString()}</td><td><span class="badge ${payment.refund_status === 'refunded' ? 'pending' : 'paid'}">${payment.refund_status === 'refunded' ? 'REFUNDED' : 'CONFIRMED'}</span></td><td><button class="primary-button ticket-badge-button" data-payment-id="${payment.id}">QR badge</button><button class="text-button ticket-receipt-button" data-payment-id="${payment.id}">${receipt ? 'Receipt' : 'Receipt'}</button>${payment.refund_status === 'refunded' ? '' : '<button class="text-button ticket-refund-button" data-payment-id="' + payment.id + '">Refund</button>'}</td></tr>`; }).join('');
  const revenue = paidPayments.reduce((total, payment) => total + payment.amount, 0);
  layout(`<header class="topbar"><div><p class="eyebrow">Events</p><h1>Ticket revenue</h1><p class="subtle">Confirmed ticket holders and event collections.</p></div></header><section class="stats"><div class="stat"><p>Ticket revenue</p><strong>${money(revenue)}</strong></div><div class="stat"><p>Confirmed tickets</p><strong>${paidPayments.length}</strong></div></section><section class="panel"><div class="panel-heading"><h2>Paid ticket holders</h2></div><table class="table"><thead><tr><th>Index number</th><th>Name</th><th>Event</th><th>Amount</th><th>Paid at</th><th>Status</th><th>Badge</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No confirmed ticket payments yet.</td></tr>'}</tbody></table></section>`);
  document.querySelectorAll<HTMLButtonElement>('.ticket-badge-button').forEach((button) => button.onclick = () => { const payment = paidPayments.find((item) => item.id === button.dataset.paymentId); const ticket = payment && typedTickets.find((item) => item.due_id === payment.due_id); if (payment && ticket) showTicketBadgeQr(payment, ticket); });
  document.querySelectorAll<HTMLButtonElement>('.ticket-receipt-button').forEach((button) => button.onclick = () => { const payment = paidPayments.find((item) => item.id === button.dataset.paymentId); if (payment) downloadReceipt(payment); });
  document.querySelectorAll<HTMLButtonElement>('.ticket-refund-button').forEach((button) => button.onclick = async () => { const payment = paidPayments.find((item) => item.id === button.dataset.paymentId); if (!payment || !window.confirm('Refund this ticket payment through Paystack and mark it as refunded in the system?')) return; const reason = window.prompt('Refund reason', 'Admin refund') || 'Admin refund'; button.disabled = true; try { const refundUrl = import.meta.env.VITE_PAYSTACK_REFUND_URL || '/api/paystack-refund'; const response = await fetch(refundUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: payment.paystack_reference, amount: payment.amount, reason }) }); const result = await response.json() as { error?: string; success?: boolean; amount?: number; reference?: string }; if (!response.ok || !result.success) { throw new Error(result.error || 'Paystack refund failed.'); } const { error } = await supabase.from('payments').update({ refund_status: 'refunded', refund_reason: reason, refunded_at: new Date().toISOString() }).eq('id', payment.id); if (error) { throw new Error(error.message); } await logAudit('refund', 'payment', payment.id, { reason, reference: payment.paystack_reference, amount: payment.amount }); await ticketRevenueDashboard(); } catch (error) { button.disabled = false; alert(errorText(error)); } });
}

function installTicketNavigation() {
  const nav = document.querySelector<HTMLElement>('.nav');
  if (!nav || nav.querySelector('[data-ticket-nav]')) return;
  const button = document.createElement('button');
  button.dataset.ticketNav = 'true'; button.dataset.page = 'Tickets'; button.textContent = 'Tickets';
  button.onclick = () => { selectedPage = 'Tickets'; void ticketDashboard(); };
  nav.append(button);
  if (profile?.role === 'member') {
    const boughtButton = document.createElement('button');
    boughtButton.dataset.ticketBoughtNav = 'true'; boughtButton.dataset.page = 'Tickets bought'; boughtButton.textContent = 'Tickets bought';
    boughtButton.onclick = () => { selectedPage = 'Tickets bought'; void boughtTicketsDashboard(); };
    nav.append(boughtButton);
  }
  if (profile?.role === 'admin') {
    const revenueButton = document.createElement('button');
    revenueButton.dataset.ticketRevenueNav = 'true'; revenueButton.dataset.page = 'Ticket revenue'; revenueButton.textContent = 'Ticket revenue';
    revenueButton.onclick = () => { selectedPage = 'Ticket revenue'; void ticketRevenueDashboard(); };
    nav.append(revenueButton);
    const auditButton = document.createElement('button');
    auditButton.dataset.auditNav = 'true'; auditButton.dataset.page = 'Audit logs'; auditButton.textContent = 'Audit logs';
    auditButton.onclick = () => { selectedPage = 'Audit logs'; void auditLogsDashboard(); };
    nav.append(auditButton);
  }
}

async function boughtTicketsDashboard() {
  const { data: tickets = [], error: ticketError } = await supabase.from('tickets').select('id,due_id,event_name,ticket_type,description,image_url,index_numbers,dues(id,title,amount,due_date,status,member_id)').eq('organization_id', profile?.organization_id).order('created_at', { ascending: false });
  if (ticketError) return layout(`<div class="state-message">${esc(ticketError.message)}</div>`);
  const ticketIds = (tickets as unknown as Ticket[]).map((ticket) => ticket.due_id);
  const { data: payments = [], error: paymentError } = ticketIds.length ? await supabase.from('payments').select('id,due_id,amount,status,paystack_reference,paid_at,created_at,profiles(index_number,full_name),dues(title,due_date)').eq('member_id', user?.id).in('due_id', ticketIds).eq('status', 'paid').order('paid_at', { ascending: false }) : { data: [], error: null };
  if (paymentError) return layout(`<div class="state-message">${esc(paymentError.message)}</div>`);
  const typedTickets = tickets as unknown as Ticket[];
  const cards = (payments as unknown as Payment[]).map((payment) => { const ticket = typedTickets.find((item) => item.due_id === payment.due_id); const member = Array.isArray(payment.profiles) ? payment.profiles[0] : payment.profiles; return `<article class="ticket-card bought-ticket"><div class="ticket-card-placeholder">CONFIRMED</div><div class="ticket-card-body"><p class="eyebrow">${esc(ticket?.ticket_type?.toUpperCase() || 'TICKET')}</p><h2>${esc(ticket?.event_name || 'Event ticket')}</h2><p>${esc(member?.full_name || profile?.full_name || 'Member')} · ${esc(member?.index_number || profile?.index_number || 'No index')}</p><p>Paid ${esc(new Date(payment.paid_at || payment.created_at).toLocaleString())}</p><strong>${money(payment.amount)}</strong><button class="primary-button bought-ticket-qr" data-payment-id="${payment.id}">Show QR badge</button></div></article>`; }).join('');
  layout(`<header class="topbar"><div><p class="eyebrow">Events</p><h1>Tickets bought</h1><p class="subtle">Your confirmed event tickets and entry badges.</p></div></header><section class="ticket-grid">${cards || '<div class="state-message">You have not bought any tickets yet.</div>'}</section>`);
  document.querySelectorAll<HTMLButtonElement>('.bought-ticket-qr').forEach((button) => button.onclick = () => { const payment = (payments as unknown as Payment[]).find((item) => item.id === button.dataset.paymentId); const ticket = payment && typedTickets.find((item) => item.due_id === payment.due_id); if (payment && ticket) showTicketBadgeQr(payment, ticket); });
}

async function auditLogsDashboard() {
  const { data, error } = await supabase.from('audit_logs').select('id,action,entity_type,entity_id,details,created_at,profiles(full_name,index_number)').eq('organization_id', profile?.organization_id).order('created_at', { ascending: false }).limit(100);
  if (error) return layout(`<div class="state-message">${esc(errorText(error))}</div>`);
  const rows = (data || []).map((log) => { const actor = Array.isArray(log.profiles) ? log.profiles[0] : log.profiles; return `<tr><td>${date(log.created_at)} ${new Date(log.created_at).toLocaleTimeString()}</td><td>${esc(actor?.full_name || 'Admin')}</td><td>${esc(log.action)}</td><td>${esc(log.entity_type)}</td><td>${esc(log.entity_id || '')}</td><td>${esc(JSON.stringify(log.details || {}))}</td></tr>`; }).join('');
  layout(`<header class="topbar"><div><p class="eyebrow">Administration</p><h1>Audit logs</h1><p class="subtle">Recent administrative changes and refund actions.</p></div></header><section class="panel"><table class="table"><thead><tr><th>Time</th><th>Admin</th><th>Action</th><th>Entity</th><th>ID</th><th>Details</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No audit actions recorded yet.</td></tr>'}</tbody></table></section>`);
}

async function render() { if (!supabaseConfigured) return configurationScreen(); if (!user || !profile) return authScreen(); dashboardSkeleton(); try { if (profile.role === 'admin') await adminView(); else await memberViewWithSections(); installTicketNavigation(); } catch (error) { layout(`<div class="state-message"><strong>Could not load this page.</strong><br>${esc(errorText(error))}<br><button class="primary-button" id="retry-render">Retry</button></div>`); document.querySelector<HTMLButtonElement>('#retry-render')!.onclick = () => void render(); } }

new MutationObserver(() => installTicketNavigation()).observe(app, { childList: true, subtree: true });

const publicPaymentQr = hasPublicPaymentQr();
const publicPrivacyPage = new URLSearchParams(window.location.search).has('privacy');
if (publicPrivacyPage) {
  privacyPage();
} else if (publicPaymentQr) {
  showPaymentQrFromUrl();
} else if (supabaseConfigured) {
  supabase.auth.getSession().then(({ data, error }) => {
    if (error) authScreen(`Unable to restore your session: ${error.message}`);
    else void boot(data.session?.user ?? null);
  }).catch((error: unknown) => authScreen(`Unable to connect to Supabase: ${errorText(error)}`));
} else configurationScreen();
if (!publicPaymentQr && !publicPrivacyPage) supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT' || !session) { user = null; profile = null; authScreen(); }
});
