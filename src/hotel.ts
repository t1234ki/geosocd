import './hotel.css';
import { supabase, supabaseConfigured } from './supabase';
import QRCode from 'qrcode';
import type { User } from '@supabase/supabase-js';

type Availability = 'available' | 'reserved' | 'occupied' | 'maintenance';
interface Room { id: string; category_id: string; category_name: string; description: string; nightly_rate: number; capacity: number; amenities: string[]; room_name: string; floor_number: number; wing: string; sort_order: number; availability: Availability; }
interface Booking { booking_reference: string; guest_full_name: string; guest_email: string; guest_phone: string; check_in: string; check_out: string; guest_count: number; nightly_rate: number; total_amount: number; status: string; room_name?: string; category_name?: string; amenities?: string[]; }
interface StaffBooking extends Booking { id: string; room_name: string; category_name: string; }
interface Category { id: string; name: string; description: string; nightly_rate: number; capacity: number; amenities: string[]; }
interface InventoryRoom { id: string; category_id: string; room_name: string; floor_number: number; wing: string; sort_order: number; operational_status: 'active' | 'maintenance'; }

const app = document.querySelector<HTMLDivElement>('#app')!;
const HOTEL_PHONE = '+233 20 421 7037';
const HOTEL_ADDRESS = 'Pedu Estate Road, Cape Coast, Ghana';
const money = (amount: number) => `GH₵${Number(amount).toLocaleString('en-GH')}`;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
let sessionUser: User | null = null;
let selectedRoom: Room | null = null;
let searchDates = { checkIn: addDaysISO(1), checkOut: addDaysISO(3), guests: 2 };
let rooms: Room[] = [];
let bookingResult: Booking | null = null;
let staffMode = false;
let staffAuthError = '';
let guestAuthView: 'login' | 'signup' = 'login';
let selectedFloor = 'all';

function nightsBetween(start: string, end: string) { return Math.max(1, Math.ceil((new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86400000)); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDaysISO(days: number) { const date = new Date(); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); }
function nextDayISO(value: string) { const date = new Date(`${value}T12:00:00`); date.setDate(date.getDate() + 1); return date.toISOString().slice(0, 10); }
function initials(value: string) { return value.trim().split(/\s+/).map((part) => part[0] || '').join('').slice(0, 2).toUpperCase() || 'G'; }

function header() {
  return `<header class="hotel-nav"><a class="hotel-brand" href="#top" aria-label="Jonat Hotel home"><span class="jonat-monogram">J</span><span><strong>JONAT</strong><small>HOTEL · CAPE COAST</small></span></a><button class="mobile-menu-toggle" id="mobile-menu-toggle" type="button" aria-label="Open navigation" aria-expanded="false"><span></span><span></span><span></span></button><nav class="hotel-nav-links" id="hotel-nav-links"><a href="#stay">The stay</a><a href="#how-it-works">How it works</a><a href="#deck">Room deck</a><a href="#location">Location</a></nav><div class="hotel-nav-actions"><button class="guest-account" id="guest-account" type="button" aria-label="${sessionUser ? 'Manage guest profile or sign out' : 'Sign in or create an optional guest account'}" title="Optional guest profile. You can also reserve without an account."><span class="guest-account-icon">${sessionUser ? esc(initials(String(sessionUser.user_metadata?.full_name || sessionUser.email || 'Guest'))) : 'G'}</span><span class="guest-account-label"><strong>${sessionUser ? esc(sessionUser.user_metadata?.full_name || 'My account') : 'Guest account'}</strong><small>${sessionUser ? 'Manage profile' : 'Optional · book without one'}</small></span><span class="guest-account-chevron">⌄</span></button><button class="staff-open" id="staff-open" type="button">Staff sign in</button></div></header>`;
}
function shell(content: string) {
  app.innerHTML = `<div class="hotel-app" id="top">${header()}${content}<footer class="hotel-footer"><div><a class="hotel-brand" href="#top"><span class="jonat-monogram">J</span><span><strong>JONAT</strong><small>HOTEL · CAPE COAST</small></span></a><p>Stay well. Arrive ready.</p></div><div><b>Find us</b><p>${HOTEL_ADDRESS}</p><a href="tel:+233204217037">${HOTEL_PHONE}</a></div><div><b>At the hotel</b><p>Restaurant · Bar · Garden</p><p>Room service · Private parking</p></div><div class="footer-credit">Reservations powered by <strong>ElectionBridge</strong></div></footer></div>`;
  document.querySelector<HTMLButtonElement>('#staff-open')!.onclick = () => showStaffLogin();
  document.querySelector<HTMLButtonElement>('#guest-account')!.onclick = () => sessionUser ? void guestSignOut() : showGuestAuth();
  const menuToggle = document.querySelector<HTMLButtonElement>('#mobile-menu-toggle');
  menuToggle?.addEventListener('click', () => {
    const isOpen = document.querySelector('.hotel-nav')?.classList.toggle('mobile-menu-open') || false;
    menuToggle.setAttribute('aria-expanded', String(isOpen));
    menuToggle.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
  });
  document.querySelectorAll<HTMLAnchorElement>('#hotel-nav-links a').forEach((link) => link.addEventListener('click', () => {
    document.querySelector('.hotel-nav')?.classList.remove('mobile-menu-open');
    menuToggle?.setAttribute('aria-expanded', 'false');
    menuToggle?.setAttribute('aria-label', 'Open navigation');
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-scroll]').forEach((button) => button.onclick = () => document.querySelector(button.dataset.scroll || '#top')?.scrollIntoView({ behavior: 'smooth' }));
}

function renderLanding(message = '') {
  const minDate = todayISO();
  shell(`<main><section class="hero-band"><div class="hero-picture" role="img" aria-label="Illustrative Cape Coast hotel stay inspiration"></div><div class="hero-copy"><p class="eyebrow">CAPE COAST · GHANA</p><h1>A quieter kind<br>of <em>arrival.</em></h1><p class="hero-description">Make room for a good night, a slower morning, and the coast just beyond the city.</p><div class="hero-location"><span class="location-pin">⌖</span><span>${HOTEL_ADDRESS}</span></div><a class="hero-link" href="#search">Find your room <span>↓</span></a></div><div class="hero-caption">AN ILLUSTRATIVE VIEW OF A THOUGHTFUL STAY</div></section><section class="flight-search-wrap" id="search"><div class="search-heading"><div><p class="eyebrow">YOUR STAY, AT A GLANCE</p><h2>Plan your arrival</h2></div><span class="search-step">01 <i>/ 03</i></span></div><form id="availability-form" class="flight-search"><label><span>ARRIVAL</span><input id="check-in" name="check_in" type="date" min="${minDate}" value="${esc(searchDates.checkIn)}" required></label><span class="search-arrow" aria-hidden="true">→</span><label><span>DEPARTURE</span><input id="check-out" name="check_out" type="date" min="${nextDayISO(searchDates.checkIn)}" value="${esc(searchDates.checkOut)}" required></label><label class="guest-field"><span>GUESTS</span><select id="guest-count" name="guests"><option value="1" ${searchDates.guests === 1 ? 'selected' : ''}>01 guest</option><option value="2" ${searchDates.guests === 2 ? 'selected' : ''}>02 guests</option><option value="3" ${searchDates.guests === 3 ? 'selected' : ''}>03 guests</option><option value="4" ${searchDates.guests === 4 ? 'selected' : ''}>04 guests</option></select></label><button class="search-submit" type="submit"><span>Search rooms</span><b>↗</b></button></form><p class="search-help">No payment details required. Reserve now and pay at the hotel desk.</p>${message ? `<p class="hotel-error" role="alert">${esc(message)}</p>` : ''}</section><section class="how-it-works" id="how-it-works"><div class="how-heading"><p class="eyebrow">SIMPLE FROM SEARCH TO CHECK-IN</p><h2>How your stay works</h2></div><div class="how-steps"><article><span>01</span><div><h3>Choose your dates</h3><p>Search the room deck for your arrival, departure, and party size.</p></div></article><article><span>02</span><div><h3>Reserve your room</h3><p>Pick an available room and enter guest contact details. No card is needed.</p></div></article><article><span>03</span><div><h3>Pay when you arrive</h3><p>Show your booking pass at reception, settle your balance, and collect your key.</p></div></article></div></section><section class="stay-intro" id="stay"><div><p class="eyebrow">THE JONAT STAY</p><h2>Room to settle in.<br>Space to feel away.</h2></div><p>Settle into Pedu Estate, where a considered room and the ease of a 24-hour front desk make Cape Coast yours to explore at your own pace.</p></section><section class="amenity-strip"><div><span class="amenity-icon">◌</span><strong>Restaurant & bar</strong><small>Good things, close by</small></div><div><span class="amenity-icon">⌂</span><strong>Garden setting</strong><small>A breath between plans</small></div><div><span class="amenity-icon">◷</span><strong>24-hour front desk</strong><small>Here when you arrive</small></div><div><span class="amenity-icon">P</span><strong>Private parking</strong><small>Park and settle in</small></div></section><section class="deck-section" id="deck"><div class="section-heading"><div><p class="eyebrow">A ROOM WITH YOUR NAME ON IT</p><h2>Choose your room</h2></div><button class="deck-search-link" data-scroll="#search" type="button">Set travel dates <span>↑</span></button></div><div class="deck-empty"><div class="deck-empty-mark">J</div><h3>Your cabin deck is ready when you are.</h3><p>Select arrival and departure dates above to see live room availability.</p></div></section><section class="location-band" id="location"><div><p class="eyebrow">THE ADDRESS</p><h2>Find your way<br>to Pedu Estate.</h2><p>${HOTEL_ADDRESS}</p><a class="map-link" href="https://maps.google.com/?q=Jonat+Hotel+Pedu+Estate+Cape+Coast" target="_blank" rel="noreferrer">Open map <span>↗</span></a></div><div class="map-art" aria-label="Map illustration of Cape Coast"><div class="map-grid"></div><div class="map-route"><i></i><i></i><i></i><i></i><span>JONAT HOTEL</span></div><small>CAPE COAST · CENTRAL REGION</small></div></section><section class="reserve-footnote"><span>RESERVE WITH CONFIDENCE</span><p>Pay at the hotel. Your room is held under your unique booking reference.</p><a href="tel:+233204217037">Questions? Call ${HOTEL_PHONE}</a></section></main>`);
  const form = document.querySelector<HTMLFormElement>('#availability-form')!;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const checkIn = document.querySelector<HTMLInputElement>('#check-in')!.value;
    const checkOut = document.querySelector<HTMLInputElement>('#check-out')!.value;
    const guests = Number(document.querySelector<HTMLSelectElement>('#guest-count')!.value);
    if (checkOut <= checkIn) { renderLanding('Departure date must be after arrival.'); return; }
    searchDates = { checkIn, checkOut, guests };
    await loadAvailability();
  };
  document.querySelector<HTMLInputElement>('#check-in')!.onchange = (event) => { const value = (event.target as HTMLInputElement).value; document.querySelector<HTMLInputElement>('#check-out')!.min = nextDayISO(value); if (document.querySelector<HTMLInputElement>('#check-out')!.value <= value) document.querySelector<HTMLInputElement>('#check-out')!.value = nextDayISO(value); };
}

async function loadAvailability() {
  if (!supabaseConfigured) { renderLanding('Room search is being prepared. Please call the hotel to check current availability.'); return; }
  app.classList.add('is-loading');
  const { data, error } = await supabase.rpc('hotel_room_availability', { p_check_in: searchDates.checkIn, p_check_out: searchDates.checkOut });
  app.classList.remove('is-loading');
  if (error) { history.replaceState({ page: 'home' }, '', '/'); renderLanding('Room search is temporarily unavailable. Please call the hotel directly for assistance.'); return; }
  rooms = (data || []) as Room[];
  const params = new URLSearchParams({ rooms: '1', arrival: searchDates.checkIn, departure: searchDates.checkOut, guests: String(searchDates.guests) });
  if (new URLSearchParams(location.search).has('rooms')) history.replaceState({ page: 'rooms' }, '', `/?${params.toString()}`);
  else history.pushState({ page: 'rooms' }, '', `/?${params.toString()}`);
  renderCabinDeck();
}

function renderCabinDeck() {
  const availableCount = rooms.filter((room) => room.availability === 'available' && room.capacity >= searchDates.guests).length;
  const floors = Array.from(new Set(rooms.map((room) => room.floor_number))).sort((a, b) => a - b);
  const floorRooms = rooms.filter((room) => selectedFloor === 'all' || String(room.floor_number) === selectedFloor);
  const groups = new Map<string, Room[]>();
  floorRooms.forEach((room) => { const key = `FLOOR ${room.floor_number} · WING ${room.wing}`; groups.set(key, [...(groups.get(key) || []), room]); });
  const deckGroups = Array.from(groups.entries()).map(([label, items]) => `<section class="deck-group"><div class="deck-group-label"><span>${esc(label)}</span><i>${items.length} rooms</i></div><div class="deck-cabin">${items.map((room, index) => `<button class="cabin-room status-${esc(room.availability)} ${selectedRoom?.id === room.id ? 'is-selected' : ''}" data-room-id="${room.id}" ${room.availability !== 'available' || room.capacity < searchDates.guests ? 'disabled' : ''} aria-label="${esc(room.room_name)}, ${esc(room.category_name)}, ${esc(room.availability)}"><span class="cabin-seat-number">${String(index + 1).padStart(2, '0')}</span><strong>${esc(room.room_name)}</strong><small>${esc(room.category_name)}</small><b>${money(room.nightly_rate)}<i> / night</i></b></button>`).join('')}</div></section>`).join('');
  const bookingDetails = selectedRoom ? bookingPanel(selectedRoom) : `<aside class="booking-placeholder"><span class="booking-step-number">02</span><p class="eyebrow">YOUR SELECTION</p><h3>Choose an available room.</h3><p>Room details, stay total, and your reservation form will appear here.</p><div class="booking-placeholder-rule"></div><div class="mini-legends"><span><i class="legend-available"></i> Available</span><span><i class="legend-reserved"></i> Reserved</span><span><i class="legend-occupied"></i> Occupied / closed</span></div></aside>`;
  shell(`<main class="deck-page"><div class="deck-breadcrumb"><button type="button" id="back-search">← Edit trip search</button><span>${new Date(`${searchDates.checkIn}T12:00:00`).toLocaleDateString('en-GH', { day: 'numeric', month: 'short' })} — ${new Date(`${searchDates.checkOut}T12:00:00`).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' })}</span><span>${searchDates.guests} guest${searchDates.guests > 1 ? 's' : ''}</span></div><header class="deck-title"><div><p class="eyebrow">JONAT HOTEL · ROOM DECK</p><h1>Select your room.</h1><p>${nightsBetween(searchDates.checkIn, searchDates.checkOut)} nights · ${availableCount} available for your party</p></div><span class="search-step">02 <i>/ 03</i></span></header><div class="deck-filters"><div class="status-legend"><span><i class="legend-available"></i> Available</span><span><i class="legend-reserved"></i> Reserved</span><span><i class="legend-occupied"></i> Occupied / maintenance</span></div><label class="floor-select">FLOOR<select id="floor-filter"><option value="all">All floors</option>${floors.map((floor) => `<option value="${floor}" ${selectedFloor === String(floor) ? 'selected' : ''}>Floor ${floor}</option>`).join('')}</select></label></div><div class="deck-layout"><div class="cabin-map">${deckGroups || `<div class="deck-empty"><h3>No rooms are published yet.</h3><p>Our team is preparing the room deck. Please call ${HOTEL_PHONE} to reserve by phone.</p></div>`}</div>${bookingDetails}</div><p class="deck-footnote">Inventory updates as dates are searched. Reservations are held for pay-at-hotel; room charges are settled at the front desk.</p></main>`);
  document.querySelector<HTMLButtonElement>('#back-search')!.onclick = () => { selectedRoom = null; history.pushState({ page: 'home' }, '', '/'); renderLanding(); };
  document.querySelector<HTMLSelectElement>('#floor-filter')!.onchange = (event) => { selectedFloor = (event.target as HTMLSelectElement).value; renderCabinDeck(); };
  document.querySelectorAll<HTMLButtonElement>('.cabin-room:not(:disabled)').forEach((button) => button.onclick = () => { selectedRoom = rooms.find((room) => room.id === button.dataset.roomId) || null; renderCabinDeck(); });
  bindReservationForm();
}

function bookingPanel(room: Room) {
  const nights = nightsBetween(searchDates.checkIn, searchDates.checkOut);
  const total = room.nightly_rate * nights;
  return `<aside class="booking-panel"><div class="booking-panel-top"><p class="eyebrow">YOUR SELECTION</p><span class="selection-step">03 / 03</span></div><div class="selected-room-heading"><span class="selected-room-glyph">${esc(room.room_name.slice(-2))}</span><div><h3>${esc(room.room_name)}</h3><p>${esc(room.category_name)} · Floor ${room.floor_number}, Wing ${esc(room.wing)}</p></div></div><p class="room-description">${esc(room.description || 'A comfortable room to settle in for your Cape Coast stay.')}</p><div class="amenity-tags">${room.amenities.slice(0, 4).map((item) => `<span>${esc(item)}</span>`).join('')}</div><div class="selected-dates"><div><small>ARRIVAL</small><strong>${new Date(`${searchDates.checkIn}T12:00:00`).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' })}</strong></div><span>→</span><div><small>DEPARTURE</small><strong>${new Date(`${searchDates.checkOut}T12:00:00`).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' })}</strong></div></div><div class="price-breakdown"><span>${money(room.nightly_rate)} × ${nights} nights</span><strong>${money(total)}</strong><small>Pay at hotel · no card details required</small></div><form id="reservation-form" class="reservation-form"><label>FULL NAME<input id="guest-name" name="full_name" autocomplete="name" required value="${esc(sessionUser?.user_metadata?.full_name || '')}" placeholder="Name on reservation"></label><label>EMAIL ADDRESS<input id="guest-email" name="email" type="email" autocomplete="email" required value="${esc(sessionUser?.email || '')}" placeholder="you@example.com"></label><label>PHONE NUMBER<input id="guest-phone" name="phone" type="tel" autocomplete="tel" required value="${esc(sessionUser?.user_metadata?.phone || '')}" placeholder="+233 …"></label><button class="confirm-reservation" type="submit">Reserve · pay at hotel <span>↗</span></button><p class="form-note">By reserving, you agree to settle the room total at Jonat Hotel on arrival.</p></form></aside>`;
}

function bindReservationForm() {
  const form = document.querySelector<HTMLFormElement>('#reservation-form');
  if (!form || !selectedRoom) return;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const room = selectedRoom;
    if (!room) return;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    button.innerHTML = 'Holding your room…';
    const guestName = document.querySelector<HTMLInputElement>('#guest-name')!.value.trim();
    const guestEmail = document.querySelector<HTMLInputElement>('#guest-email')!.value.trim();
    const guestPhone = document.querySelector<HTMLInputElement>('#guest-phone')!.value.trim();
    const { data, error } = await supabase.rpc('hotel_create_reservation', {
      p_room_id: room.id,
      p_full_name: guestName,
      p_email: guestEmail,
      p_phone: guestPhone,
      p_check_in: searchDates.checkIn,
      p_check_out: searchDates.checkOut,
      p_guest_count: searchDates.guests,
    });
    if (error || !data) {
      button.disabled = false;
      button.innerHTML = 'Reserve · pay at hotel <span>↗</span>';
      const errorBox = document.querySelector<HTMLElement>('.reservation-error');
      if (errorBox) errorBox.textContent = error?.message || 'Could not create reservation. Please try again.';
      else button.insertAdjacentHTML('beforebegin', `<p class="reservation-error">${esc(error?.message || 'Room reservation is not available yet. Apply the Jonat Hotel database setup first.')}</p>`);
      return;
    }
    bookingResult = data as Booking;
    renderBoardingPass(bookingResult, room);
  };
}

function applyHotelBranding() {
  const heading = app.querySelector<HTMLElement>('.hero-copy h1');
  if (heading && !heading.textContent?.includes('Relax into our')) heading.innerHTML = 'Relax into our<br><em>luxury.</em>';
  const footerMotto = app.querySelector<HTMLElement>('.hotel-footer > div:first-child > p');
  if (footerMotto && footerMotto.textContent !== 'Relax into our luxury') footerMotto.textContent = 'Relax into our luxury';
  const amenities = app.querySelector<HTMLElement>('.amenity-strip');
  if (amenities && amenities.dataset.jonatFacilities !== 'true') {
    amenities.dataset.jonatFacilities = 'true';
    amenities.innerHTML = `<div><span class="amenity-icon">⌂</span><strong>Accommodation</strong><small>Comfort for every stay</small></div><div><span class="amenity-icon">◌</span><strong>Restaurant</strong><small>Dining at the hotel</small></div><div><span class="amenity-icon">▦</span><strong>Conference room</strong><small>Space to meet</small></div><div><span class="amenity-icon">▱</span><strong>Mini bar & garden</strong><small>Unwind at your pace</small></div><div><span class="amenity-icon">◉</span><strong>24-hour security cameras</strong><small>Monitored around the clock</small></div><div><span class="amenity-icon">P</span><strong>Spacious car park</strong><small>Convenient on-site parking</small></div>`;
  }
}

new MutationObserver(() => applyHotelBranding()).observe(app, { childList: true, subtree: true });
applyHotelBranding();

function renderBoardingPass(booking: Booking, room?: Room) {
  const nights = nightsBetween(booking.check_in, booking.check_out);
  const roomName = room?.room_name || booking.room_name || 'Assigned room';
  shell(`<main class="boarding-page"><div class="boarding-back"><a href="#top" id="new-search">← Return to Jonat Hotel</a></div><div class="boarding-heading"><p class="eyebrow">RESERVATION CONFIRMED · PAY AT HOTEL</p><h1>Your stay is<br><em>cleared for arrival.</em></h1><p>We have held your room. Keep this boarding pass handy and present your reference at the front desk.</p></div><article class="boarding-pass"><div class="pass-main"><div class="pass-airline"><span class="jonat-monogram">J</span><div><strong>JONAT HOTEL</strong><small>GUEST BOARDING PASS</small></div><span class="pass-status">${esc(booking.status.toUpperCase())}</span></div><div class="pass-guest"><small>GUEST</small><h2>${esc(booking.guest_full_name)}</h2><span>${esc(booking.guest_email)} · ${esc(booking.guest_phone)}</span></div><div class="pass-route"><div><small>ARRIVAL</small><strong>${new Date(`${booking.check_in}T12:00:00`).toLocaleDateString('en-GH', { day: '2-digit', month: 'short' })}</strong><span>${booking.check_in}</span></div><div class="route-line"><i></i><span>${nights} NIGHT${nights === 1 ? '' : 'S'}</span><i></i></div><div class="route-destination"><small>DEPARTURE</small><strong>${new Date(`${booking.check_out}T12:00:00`).toLocaleDateString('en-GH', { day: '2-digit', month: 'short' })}</strong><span>${booking.check_out}</span></div></div><div class="pass-seat-row"><div><small>ROOM / SEAT</small><strong>${esc(roomName)}</strong></div><div><small>ROOM TYPE</small><strong>${esc(room?.category_name || booking.category_name || 'Jonat room')}</strong></div><div><small>GUESTS</small><strong>${booking.guest_count}</strong></div></div></div><div class="pass-stub"><div class="stub-notch"></div><small>BOOKING REFERENCE</small><strong class="pass-reference">${esc(booking.booking_reference)}</strong><div id="booking-qr" class="booking-qr"></div><span class="pass-total">${money(booking.total_amount)}<small>PAY AT HOTEL</small></span></div></article><div class="arrival-note"><span class="arrival-icon">i</span><p><strong>On arrival at Jonat Hotel, Pedu Estate</strong><br>Present reference <b>${esc(booking.booking_reference)}</b> at reception to complete payment and collect your room key.</p></div><button class="print-pass" id="print-pass">Print boarding pass</button><button class="lookup-again" id="lookup-booking">Look up a booking</button></main>`);
  document.querySelector<HTMLButtonElement>('#print-pass')!.onclick = () => window.print();
  document.querySelector<HTMLButtonElement>('#lookup-booking')!.onclick = () => renderLookup();
  const qrNode = document.querySelector<HTMLDivElement>('#booking-qr')!;
  const canvas = document.createElement('canvas');
  canvas.className = 'boarding-qr-canvas';
  qrNode.append(canvas);
  void QRCode.toCanvas(canvas, `${booking.booking_reference}|${booking.guest_email}`).catch(() => { qrNode.textContent = booking.booking_reference; });
}

async function renderLookup(message = '') {
  shell(`<main class="lookup-page"><a class="back-home" href="#top">← Jonat Hotel</a><section class="lookup-card"><p class="eyebrow">YOUR RESERVATION</p><h1>Find your<br><em>boarding pass.</em></h1><p>Enter your booking reference and the email used for the reservation.</p>${message ? `<p class="hotel-error">${esc(message)}</p>` : ''}<form id="lookup-form"><label>BOOKING REFERENCE<input id="lookup-reference" required placeholder="JH-8492"></label><label>EMAIL ADDRESS<input id="lookup-email" type="email" required placeholder="you@example.com"></label><button class="confirm-reservation" type="submit">Find reservation <span>↗</span></button></form></section></main>`);
  document.querySelector<HTMLFormElement>('#lookup-form')!.onsubmit = async (event) => {
    event.preventDefault();
    const reference = document.querySelector<HTMLInputElement>('#lookup-reference')!.value.trim();
    const email = document.querySelector<HTMLInputElement>('#lookup-email')!.value.trim();
    const { data, error } = await supabase.rpc('hotel_find_reservation', { p_booking_reference: reference, p_email: email });
    if (error || !data) { await renderLookup('No reservation matched those details. Check them and try again.'); return; }
    renderBoardingPass(data as Booking);
  };
}

function showStaffLogin(message = staffAuthError) {
  shell(`<main class="staff-login-page"><section class="staff-login-card"><button class="close-staff" id="close-staff" aria-label="Close">×</button><p class="eyebrow">JONAT HOTEL · OPERATIONS</p><h1>Staff access</h1><p>Sign in with the email and password for your hotel staff Supabase Auth account. Guest accounts do not have staff access.</p>${message ? `<p class="hotel-error">${esc(message)}</p>` : ''}<form id="staff-login-form"><label>EMAIL<input id="staff-email" type="email" required autocomplete="username"></label><label>PASSWORD<input id="staff-password" type="password" required autocomplete="current-password"></label><button class="confirm-reservation" type="submit">Sign in <span>↗</span></button></form><details class="staff-provisioning"><summary>Need a staff account?</summary><p>A project admin must create a user in Supabase Dashboard → Authentication → Users, then add that user's UUID to <code>public.hotel_staff</code>. See the hotel setup guide for the SQL command. There is no shared default staff password.</p></details></section></main>`);
  document.querySelector<HTMLButtonElement>('#close-staff')!.onclick = () => renderLanding();
  document.querySelector<HTMLFormElement>('#staff-login-form')!.onsubmit = async (event) => {
    event.preventDefault();
    const email = document.querySelector<HTMLInputElement>('#staff-email')!.value.trim();
    const password = document.querySelector<HTMLInputElement>('#staff-password')!.value;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) { showStaffLogin(error?.message || 'Sign in failed.'); return; }
    sessionUser = data.user;
    await loadStaffBoard();
  };
}

async function loadStaffBoard(message = '') {
  const [bookingResult, categoryResult, roomResult] = await Promise.all([
    supabase.rpc('hotel_staff_reservations'),
    supabase.from('hotel_room_categories').select('id,name,description,nightly_rate,capacity,amenities').order('name'),
    supabase.from('hotel_rooms').select('id,category_id,room_name,floor_number,wing,sort_order,operational_status').order('floor_number').order('wing').order('sort_order'),
  ]);
  if (bookingResult.error) { showStaffLogin('This account is not in the hotel staff list. Ask an administrator to provision staff access.'); return; }
  if (categoryResult.error || roomResult.error) { renderStaffBoard((bookingResult.data || []) as StaffBooking[], message || 'Apply supabase/jonat-hotel.sql to enable inventory management.'); return; }
  staffMode = true;
  renderStaffBoard((bookingResult.data || []) as StaffBooking[], message, (categoryResult.data || []) as Category[], (roomResult.data || []) as InventoryRoom[]);
}

function renderStaffBoard(bookings: StaffBooking[], message = '', categories: Category[] = [], inventory: InventoryRoom[] = []) {
  const checkInToday = bookings.filter((booking) => booking.check_in === todayISO() && booking.status === 'reserved').length;
  const occupied = bookings.filter((booking) => booking.status === 'checked_in').length;
  const rows = bookings.map((booking) => `<tr><td><strong>${esc(booking.booking_reference)}</strong><small>${esc(booking.guest_full_name)} · ${esc(booking.guest_phone)}</small></td><td>${esc(booking.room_name)}<small>${esc(booking.category_name)}</small></td><td>${booking.check_in}<small>until ${booking.check_out}</small></td><td>${money(booking.total_amount)}</td><td><span class="status-pill status-${esc(booking.status)}">${esc(booking.status.replace('_', ' '))}</span></td><td><select class="booking-status-select" data-reservation-id="${booking.id}" aria-label="Update ${esc(booking.booking_reference)} status"><option value="reserved" ${booking.status === 'reserved' ? 'selected' : ''}>Reserved</option><option value="checked_in" ${booking.status === 'checked_in' ? 'selected' : ''}>Check in</option><option value="checked_out" ${booking.status === 'checked_out' ? 'selected' : ''}>Check out</option><option value="cancelled" ${booking.status === 'cancelled' ? 'selected' : ''}>Cancel</option></select></td></tr>`).join('');
  shell(`<main class="staff-board"><header class="staff-board-heading"><div><p class="eyebrow">JONAT HOTEL · LIVE OPERATIONS</p><h1>Room operations</h1><p>Reservations, arrivals, and room turns.</p></div><button class="staff-signout" id="staff-signout">Sign out</button></header>${message ? `<p class="staff-message">${esc(message)}</p>` : ''}<div class="ops-stats"><div><small>ARRIVALS TODAY</small><strong>${checkInToday}</strong></div><div><small>IN HOUSE</small><strong>${occupied}</strong></div><div><small>RESERVATIONS</small><strong>${bookings.filter((booking) => booking.status === 'reserved').length}</strong></div></div><section class="ops-panel"><div class="ops-toolbar"><div><p class="eyebrow">THE FRONT DESK</p><h2>Reservation manifest</h2></div><button id="refresh-ops" class="staff-signout">Refresh</button></div><div class="ops-table-wrap"><table class="ops-table"><thead><tr><th>GUEST / REFERENCE</th><th>ROOM</th><th>DATES</th><th>STAY TOTAL</th><th>STATUS</th><th>UPDATE</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty-ops">No reservations to show yet.</td></tr>'}</tbody></table></div></section><p class="ops-footnote">A check-in occupies the room; check-out or cancellation releases it for new searches.</p></main>`);
  const inventoryMarkup = `<section class="inventory-management"><div class="ops-toolbar"><div><p class="eyebrow">ROOM CATALOG</p><h2>Categories & inventory</h2></div><span>${categories.length} categories · ${inventory.length} rooms</span></div><div class="inventory-forms"><form id="category-form" class="inventory-form"><h3 id="category-form-title">Add a room category</h3><input id="category-id" type="hidden"><label>Category name<input id="category-name" required placeholder="Standard, Executive suite"></label><label>Description<input id="category-description" placeholder="Room description"></label><div class="form-inline"><label>Nightly rate (GH₵)<input id="category-rate" type="number" min="1" required placeholder="Set rate"></label><label>Capacity<input id="category-capacity" type="number" min="1" value="2" required></label></div><label>Amenities<input id="category-amenities" placeholder="Air conditioning, desk, balcony"></label><button class="confirm-reservation" type="submit">Save category <span>↗</span></button></form><form id="room-form" class="inventory-form"><h3>Add a physical room</h3><label>Room name / number<input id="room-name" required placeholder="Room 101, Palm Suite"></label><label>Room category<select id="room-category" required>${categories.map((category) => `<option value="${category.id}">${esc(category.name)}</option>`).join('')}</select></label><div class="form-inline"><label>Floor<input id="room-floor" type="number" min="1" value="1" required></label><label>Wing<input id="room-wing" maxlength="12" value="A" required></label><label>Deck order<input id="room-order" type="number" min="0" value="0" required></label></div><button class="confirm-reservation" type="submit">Add room <span>↗</span></button></form></div><div class="inventory-tables"><div class="ops-table-wrap"><h3>Room categories</h3><table class="ops-table"><thead><tr><th>CATEGORY</th><th>RATE</th><th>CAPACITY</th><th>EDIT</th></tr></thead><tbody>${categories.map((category) => `<tr><td><strong>${esc(category.name)}</strong><small>${esc(category.description)}</small></td><td>${money(category.nightly_rate)} / night</td><td>${category.capacity} guests</td><td><button class="staff-signout edit-category" data-category-id="${category.id}">Edit</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty-ops">Add a category with a real rate to start.</td></tr>'}</tbody></table></div><div class="ops-table-wrap"><h3>Physical rooms</h3><table class="ops-table"><thead><tr><th>ROOM</th><th>CATEGORY</th><th>LOCATION</th><th>STATUS</th></tr></thead><tbody>${inventory.map((room) => `<tr><td><strong>${esc(room.room_name)}</strong></td><td>${esc(categories.find((category) => category.id === room.category_id)?.name || 'Uncategorized')}</td><td>Floor ${room.floor_number} · Wing ${esc(room.wing)}</td><td><select class="room-status-select" data-room-id="${room.id}"><option value="active" ${room.operational_status === 'active' ? 'selected' : ''}>Active</option><option value="maintenance" ${room.operational_status === 'maintenance' ? 'selected' : ''}>Maintenance</option></select></td></tr>`).join('') || '<tr><td colspan="4" class="empty-ops">Add room numbers to populate the deck.</td></tr>'}</tbody></table></div></div></section>`;
  document.querySelector('.staff-board .ops-panel')?.insertAdjacentHTML('beforebegin', inventoryMarkup);
  document.querySelector<HTMLButtonElement>('#staff-signout')!.onclick = async () => { await supabase.auth.signOut(); sessionUser = null; staffMode = false; renderLanding(); };
  document.querySelector<HTMLButtonElement>('#refresh-ops')!.onclick = () => void loadStaffBoard();
  document.querySelectorAll<HTMLButtonElement>('.edit-category').forEach((button) => button.onclick = () => {
    const category = categories.find((item) => item.id === button.dataset.categoryId);
    if (!category) return;
    document.querySelector<HTMLInputElement>('#category-id')!.value = category.id;
    document.querySelector<HTMLInputElement>('#category-name')!.value = category.name;
    document.querySelector<HTMLInputElement>('#category-description')!.value = category.description;
    document.querySelector<HTMLInputElement>('#category-rate')!.value = String(category.nightly_rate);
    document.querySelector<HTMLInputElement>('#category-capacity')!.value = String(category.capacity);
    document.querySelector<HTMLInputElement>('#category-amenities')!.value = category.amenities.join(', ');
    document.querySelector<HTMLElement>('#category-form-title')!.textContent = `Edit ${category.name}`;
    document.querySelector('#category-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  document.querySelector<HTMLFormElement>('#category-form')!.onsubmit = async (event) => {
    event.preventDefault();
    const categoryId = document.querySelector<HTMLInputElement>('#category-id')!.value;
    const values = { name: document.querySelector<HTMLInputElement>('#category-name')!.value.trim(), description: document.querySelector<HTMLInputElement>('#category-description')!.value.trim(), nightly_rate: Number(document.querySelector<HTMLInputElement>('#category-rate')!.value), capacity: Number(document.querySelector<HTMLInputElement>('#category-capacity')!.value), amenities: document.querySelector<HTMLInputElement>('#category-amenities')!.value.split(',').map((item) => item.trim()).filter(Boolean) };
    const result = categoryId ? await supabase.from('hotel_room_categories').update(values).eq('id', categoryId) : await supabase.from('hotel_room_categories').insert(values);
    if (result.error) { renderStaffBoard(bookings, result.error.message, categories, inventory); return; }
    await loadStaffBoard('Room category saved.');
  };
  document.querySelector<HTMLFormElement>('#room-form')!.onsubmit = async (event) => {
    event.preventDefault();
    const values = { room_name: document.querySelector<HTMLInputElement>('#room-name')!.value.trim(), category_id: document.querySelector<HTMLSelectElement>('#room-category')!.value, floor_number: Number(document.querySelector<HTMLInputElement>('#room-floor')!.value), wing: document.querySelector<HTMLInputElement>('#room-wing')!.value.trim().toUpperCase(), sort_order: Number(document.querySelector<HTMLInputElement>('#room-order')!.value) };
    const { error } = await supabase.from('hotel_rooms').insert(values);
    if (error) { renderStaffBoard(bookings, error.message, categories, inventory); return; }
    await loadStaffBoard('Room added to inventory.');
  };
  document.querySelectorAll<HTMLSelectElement>('.room-status-select').forEach((select) => select.onchange = async () => {
    const { error } = await supabase.from('hotel_rooms').update({ operational_status: select.value }).eq('id', select.dataset.roomId);
    await loadStaffBoard(error?.message || 'Room operational status updated.');
  });
  document.querySelectorAll<HTMLSelectElement>('.booking-status-select').forEach((select) => select.onchange = async () => {
    select.disabled = true;
    const { error } = await supabase.rpc('hotel_update_reservation_status', { p_reservation_id: select.dataset.reservationId, p_status: select.value });
    if (error) { select.disabled = false; renderStaffBoard(bookings, error.message); return; }
    await loadStaffBoard('Reservation status updated.');
  });
}

async function bootHotel() {
  if (!supabaseConfigured) { renderLanding('Room reservations are being configured. Please call the hotel to book.'); return; }
  const { data } = await supabase.auth.getSession();
  sessionUser = data.session?.user || null;
  await routeFromLocation();
}

async function routeFromLocation() {
  const query = new URLSearchParams(window.location.search);
  if (query.has('booking')) { renderLookup(); return; }
  if (query.has('staff')) { showStaffLogin(); return; }
  if (query.get('rooms') === '1') {
    const arrival = query.get('arrival') || '';
    const departure = query.get('departure') || '';
    const guests = Number(query.get('guests') || 2);
    if (arrival >= todayISO() && departure > arrival && guests >= 1 && guests <= 4) {
      searchDates = { checkIn: arrival, checkOut: departure, guests };
      await loadAvailability();
      return;
    }
    history.replaceState({ page: 'home' }, '', '/');
  }
  renderLanding();
}

window.addEventListener('popstate', () => { selectedRoom = null; void routeFromLocation(); });

function guestSignOut() { return supabase.auth.signOut().then(() => { sessionUser = null; renderLanding(); }); }

function showGuestAuth(message = '', prefill: { name?: string; email?: string; phone?: string } = {}) {
  document.querySelector('.hotel-modal-backdrop')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="hotel-modal-backdrop"><section class="guest-auth-card" role="dialog" aria-modal="true" aria-labelledby="guest-auth-title"><button class="guest-auth-close" id="guest-auth-close" aria-label="Close">×</button><p class="eyebrow">JONAT HOTEL · GUEST PROFILE</p><h2 id="guest-auth-title">${guestAuthView === 'login' ? 'Welcome back.' : 'Create your guest profile.'}</h2><p class="guest-auth-copy">${guestAuthView === 'login' ? 'Sign in to bring your contact details into the reservation.' : 'Save your name, email, and phone for a faster next stay.'}</p>${message ? `<p class="hotel-error">${esc(message)}</p>` : ''}<form id="guest-auth-form">${guestAuthView === 'signup' ? `<label>FULL NAME<input id="account-name" required autocomplete="name" value="${esc(prefill.name || '')}" placeholder="Full name"></label>` : ''}<label>EMAIL ADDRESS<input id="account-email" type="email" required autocomplete="email" value="${esc(prefill.email || sessionUser?.email || '')}" placeholder="you@example.com"></label>${guestAuthView === 'signup' ? `<label>PHONE NUMBER<input id="account-phone" type="tel" required autocomplete="tel" value="${esc(prefill.phone || '')}" placeholder="+233 …"></label>` : ''}<label>PASSWORD<input id="account-password" type="password" required minlength="8" autocomplete="${guestAuthView === 'login' ? 'current-password' : 'new-password'}" placeholder="At least 8 characters"></label><button class="confirm-reservation" type="submit">${guestAuthView === 'login' ? 'Sign in' : 'Create account'} <span>↗</span></button></form>${guestAuthView === 'signup' ? '<small class="guest-auth-note">If email confirmation is enabled, confirm from your inbox before signing in. You can also close this panel and reserve without an account.</small>' : ''}<button class="guest-auth-switch" id="guest-auth-switch" type="button">${guestAuthView === 'login' ? 'New to Jonat? Create a guest profile.' : 'Already have a profile? Sign in.'}</button></section></div>`);
  document.querySelector<HTMLButtonElement>('#guest-auth-close')!.onclick = () => document.querySelector('.hotel-modal-backdrop')?.remove();
  document.querySelector<HTMLButtonElement>('#guest-auth-switch')!.onclick = () => { guestAuthView = guestAuthView === 'login' ? 'signup' : 'login'; showGuestAuth(); };
  document.querySelector<HTMLFormElement>('#guest-auth-form')!.onsubmit = async (event) => {
    event.preventDefault();
    const email = document.querySelector<HTMLInputElement>('#account-email')!.value.trim();
    const password = document.querySelector<HTMLInputElement>('#account-password')!.value;
    const result = guestAuthView === 'login'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { data: { full_name: document.querySelector<HTMLInputElement>('#account-name')!.value.trim(), phone: document.querySelector<HTMLInputElement>('#account-phone')!.value.trim() } } });
    if (result.error) { showGuestAuth(result.error.message, { name: document.querySelector<HTMLInputElement>('#account-name')?.value || '', email, phone: document.querySelector<HTMLInputElement>('#account-phone')?.value || '' }); return; }
    if (guestAuthView === 'signup' && !result.data.session) { guestAuthView = 'login'; showGuestAuth('Account created. Check your email for a confirmation link, then sign in. If no email arrives, ask the hotel administrator to review Supabase Auth email settings.', { email }); return; }
    sessionUser = result.data.user;
    document.querySelector('.hotel-modal-backdrop')?.remove();
    renderLanding('Guest profile ready. Your contact details will be filled into your reservation.');
  };
}

void bootHotel();
