(function (root) {
  'use strict';
  const VERSION = 1;
  const DEMO_PASSWORD = 'Galenos2026!';
  const TZ = 'America/Santiago';
  const ROLES = ['Paciente', 'Secretaría', 'Cajero', 'Médico', 'Administrador'];
  const fail = message => { throw new Error(message); };
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = prefix => prefix + '-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
  function localParts(epoch = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(epoch));
    return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  }
  function today(epoch = Date.now()) { const p = localParts(epoch); return `${p.year}-${p.month}-${p.day}`; }
  function addDays(date, days) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
  function addMonths(date, months) {
    const d = new Date(date + 'T12:00:00Z'); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
    const max = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, max)); return d.toISOString().slice(0, 10);
  }
  function epochOf(date, time) {
    const wanted = Date.parse(date + 'T' + time + ':00Z'); let guess = wanted;
    for (let n = 0; n < 3; n++) {
      const p = localParts(guess); const observed = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
      guess += wanted - observed;
    }
    return guess;
  }
  const minutes = time => Number(time.split(':')[0]) * 60 + Number(time.split(':')[1]);
  const timeOf = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  const dateValid = date => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date + 'T12:00:00Z')) && new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) === date;
  function actor(state, userId, roles) {
    const user = state.users.find(u => u.id === userId);
    if (!user || !user.active || !roles.includes(user.role)) fail('Tu perfil no tiene permiso para realizar esta acción.');
    return user;
  }
  function audit(state, userId, action, target, detail = '') { state.audit.unshift({ id: uid('aud'), at: Date.now(), userId, action, target, detail }); }
  const doctor = (state, id) => state.doctors.find(d => d.id === id) || fail('No se encontró el profesional.');
  const specialty = (state, id) => state.specialties.find(s => s.id === id) || fail('No se encontró la especialidad.');
  const user = (state, id) => state.users.find(u => u.id === id) || fail('No se encontró el usuario.');
  function effective(history, date) { return history.filter(h => h.from <= date).sort((a, b) => b.from.localeCompare(a.from))[0]?.value ?? null; }
  function baseFor(state, specialtyId, date) { return effective(specialty(state, specialtyId).baseHistory, date); }
  function rateFor(state, doctorId, date) { return effective(doctor(state, doctorId).rateHistory, date); }
  function activeBooking(state, slotId) { return state.appointments.find(a => a.slotId === slotId && a.status !== 'Anulada'); }
  function findSlot(state, slotId) { return state.slots.find(s => s.id === slotId) || fail('Ese horario ya no existe. Elige otro.'); }
  function available(state, filters = {}, now = Date.now()) {
    const p = localParts(now); const threshold = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
    const occupied = new Set(filters.patientId ? state.appointments.filter(a => a.patientId === filters.patientId && a.status !== 'Anulada').map(a => { const s = findSlot(state, a.slotId); return s.date + 'T' + s.time; }) : []);
    return state.slots.filter(s => !s.blocked && `${s.date}T${s.time}:00` > threshold && !activeBooking(state, s.id) &&
      !occupied.has(s.date + 'T' + s.time) &&
      (!filters.branchId || s.branchId === filters.branchId) && (!filters.doctorId || s.doctorId === filters.doctorId) &&
      (!filters.specialtyId || doctor(state, s.doctorId).specialtyId === filters.specialtyId) && (!filters.date || s.date === filters.date))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }
  function notify(state, appointment, kind = 'Confirmación', now = Date.now()) {
    const slot = findSlot(state, appointment.slotId);
    state.notifications.unshift({ id: uid('mail'), appointmentId: appointment.id, patientId: appointment.patientId, kind,
      status: kind === 'Recordatorio' ? 'Programado' : 'Simulado', dueAt: kind === 'Recordatorio' ? epochOf(slot.date, slot.time) - 86400000 : now,
      attempts: kind === 'Recordatorio' ? 0 : 1, createdAt: now });
  }
  function generateSlots(state, doctorId, start, months = 3) {
    const doc = doctor(state, doctorId); const end = addMonths(start, months); let count = 0;
    for (let date = start; date < end; date = addDays(date, 1)) {
      if (state.holidays.some(h => h.date === date)) continue;
      const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
      for (const block of state.availability.filter(b => b.doctorId === doctorId && b.weekday === weekday)) {
        for (let t = minutes(block.start); t + state.settings.slotMinutes <= minutes(block.end); t += state.settings.slotMinutes) {
          const time = timeOf(t); const id = `${doctorId}_${date}_${time}`;
          if (!state.slots.some(s => s.id === id)) { state.slots.push({ id, doctorId, branchId: block.branchId || doc.branchIds[0], date, time, blocked: false }); count++; }
        }
      }
    }
    return count;
  }
  function createSeed(date = today()) {
    const state = { version: VERSION, createdAt: Date.now(), demoDate: date, settings: { slotMinutes: 30, idleMinutes: 15 },
      branches: [{ id: 'b1', name: 'Sucursal Central', address: 'Sede de demostración', active: true }, { id: 'b2', name: 'Sucursal Oriente', address: 'Sede de demostración', active: true }],
      specialties: [
        { id: 's1', name: 'Kinesiología', baseHistory: [{ from: '2020-01-01', value: 28000 }] },
        { id: 's2', name: 'Oftalmología', baseHistory: [{ from: '2020-01-01', value: 45000 }] },
        { id: 's3', name: 'Otorrinolaringología', baseHistory: [{ from: '2020-01-01', value: 40000 }] }
      ],
      doctors: [
        { id: 'd1', name: 'Dra. Sofía Rojas', specialtyId: 's1', branchIds: ['b1'], initials: 'SR', rateHistory: [{ from: '2020-01-01', value: 20 }] },
        { id: 'd2', name: 'Dr. Matías Fuentes', specialtyId: 's2', branchIds: ['b1', 'b2'], initials: 'MF', rateHistory: [{ from: '2020-01-01', value: 25 }] },
        { id: 'd3', name: 'Dra. Valentina Soto', specialtyId: 's3', branchIds: ['b2'], initials: 'VS', rateHistory: [{ from: '2020-01-01', value: 22 }] }
      ],
      users: [
        { id: 'p1', name: 'Camila Pérez', role: 'Paciente', email: 'paciente@galenos.example', rut: '11111111-1', phone: '900000001', active: true, verified: true, demo: true },
        { id: 'p2', name: 'Diego Torres', role: 'Paciente', email: 'paciente2@galenos.example', rut: '22222222-2', phone: '900000002', active: true, verified: true, demo: true },
        { id: 'u1', name: 'Ana Muñoz', role: 'Secretaría', email: 'secretaria@galenos.example', active: true, verified: true, demo: true },
        { id: 'u2', name: 'Luis Herrera', role: 'Cajero', email: 'caja@galenos.example', active: true, verified: true, demo: true, twoFactor: false },
        { id: 'u3', name: 'Dra. Sofía Rojas', role: 'Médico', email: 'medico@galenos.example', doctorId: 'd1', active: true, verified: true, demo: true },
        { id: 'u4', name: 'Administración Galenos', role: 'Administrador', email: 'admin@galenos.example', active: true, verified: true, demo: true, twoFactor: false }
      ].map(u => ({ ...u, failedAttempts: 0, lockedUntil: 0 })),
      availability: [], holidays: [{ id: 'h1', date: addDays(date, 7), name: 'Día no laborable de demostración' }], slots: [], appointments: [], payments: [],
      commissions: [], notifications: [], audit: [], sequence: { appointment: 1004, payment: 2026004, commission: 100 }, scrumNotes: [] };
    for (const doc of state.doctors) for (let weekday = 1; weekday <= 6; weekday++) state.availability.push({ id: uid('av'), doctorId: doc.id, branchId: doc.branchIds[0], weekday, start: '09:00', end: '13:00' });
    for (const doc of state.doctors) generateSlots(state, doc.id, date, 3);
    const examples = [
      { id: 'a1001', patientId: 'p1', doctorId: 'd1', date, time: '09:00', status: 'Reservada' },
      { id: 'a1002', patientId: 'p2', doctorId: 'd1', date, time: '10:00', status: 'En espera', amount: 28000 },
      { id: 'a1003', patientId: 'p2', doctorId: 'd2', date, time: '11:00', status: 'Atendida', amount: 45000 },
      { id: 'a1004', patientId: 'p1', doctorId: 'd3', date: addDays(date, 3), time: '11:00', status: 'Reservada' }
    ];
    for (const ex of examples) {
      const doc = doctor(state, ex.doctorId); const id = `${ex.doctorId}_${ex.date}_${ex.time}`;
      if (!state.slots.some(s => s.id === id)) state.slots.push({ id, doctorId: doc.id, branchId: doc.branchIds[0], date: ex.date, time: ex.time, blocked: false });
      const a = { id: ex.id, code: 'GAL-' + ex.id.slice(1), patientId: ex.patientId, slotId: id, status: ex.status, createdAt: Date.now(), needsReschedule: false };
      state.appointments.push(a);
      if (ex.amount) state.payments.push({ id: 'pay-' + ex.id, folio: 'REC-' + ex.id.slice(1), appointmentId: a.id, doctorId: doc.id, branchId: doc.branchIds[0], date: ex.date, amount: ex.amount, base: baseFor(state, doc.specialtyId, ex.date), rate: rateFor(state, doc.id, ex.date), method: 'Tarjeta', at: epochOf(ex.date, ex.time), recordedBy: 'u2' });
      notify(state, a, 'Recordatorio');
    }
    audit(state, 'system', 'Datos de demostración preparados', 'SGMG', 'Personas, sucursales, importes y calendario ficticios.');
    return state;
  }
  async function passwordHash(password, salt) {
    if (!globalThis.crypto?.subtle) fail('El navegador no permite el registro de claves aquí. Abre la versión mediante el iniciador local.');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 210000, hash: 'SHA-256' }, key, 256);
    return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function authenticate(state, email, password, now = Date.now()) {
    const u = state.users.find(u => u.email.toLowerCase() === String(email).trim().toLowerCase());
    if (!u) { audit(state, 'unknown', 'Acceso denegado', 'Sesión'); fail('Correo o contraseña incorrectos.'); }
    if (!u.active) fail('Esta cuenta está desactivada. Contacta a administración.');
    if (!u.verified) fail('Activa tu cuenta desde la bandeja de demostración antes de ingresar.');
    if (u.lockedUntil > now) fail('Cuenta bloqueada temporalmente. Inténtalo en quince minutos o solicita ayuda a administración.');
    if (u.lockedUntil && u.lockedUntil <= now) { u.failedAttempts = 0; u.lockedUntil = 0; }
    const valid = u.demo ? password === DEMO_PASSWORD : (await passwordHash(password, u.salt)) === u.passwordHash;
    if (!valid) {
      u.failedAttempts++; if (u.failedAttempts >= 5) u.lockedUntil = now + 900000;
      audit(state, u.id, 'Acceso denegado', u.id, u.failedAttempts >= 5 ? 'Bloqueo de quince minutos' : 'Credenciales incorrectas');
      fail(u.failedAttempts >= 5 ? 'Cinco intentos fallidos. La cuenta queda bloqueada quince minutos.' : 'Correo o contraseña incorrectos.');
    }
    u.failedAttempts = 0; u.lockedUntil = 0;
    audit(state, u.id, 'Primer factor verificado', 'Sesión');
    return { userId: u.id, needsTwoFactor: ['Cajero', 'Administrador'].includes(u.role) && !!u.twoFactor };
  }
  function verifyTwoFactor(state, userId, code) {
    actor(state, userId, ['Cajero', 'Administrador']);
    if (String(code) !== '246810') { audit(state, userId, 'Segundo factor rechazado', 'Sesión'); fail('Código de demostración incorrecto.'); }
    audit(state, userId, 'Segundo factor de demostración verificado', 'Sesión'); return true;
  }
  const normalizedRut = rut => String(rut).replace(/\./g, '').replace(/\s/g, '').toUpperCase();
  function validRut(rut) {
    const normalized = normalizedRut(rut); if (!/^\d{7,8}-[0-9K]$/.test(normalized)) return false;
    const [body, check] = normalized.split('-'); let sum = 0, factor = 2;
    for (let i = body.length - 1; i >= 0; i--) { sum += Number(body[i]) * factor; factor = factor === 7 ? 2 : factor + 1; }
    const n = 11 - sum % 11; return check === (n === 11 ? '0' : n === 10 ? 'K' : String(n));
  }
  async function register(state, fields) {
    const email = String(fields.email || '').trim().toLowerCase(); const rut = normalizedRut(fields.rut);
    if (!String(fields.name || '').trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !validRut(rut) || !String(fields.phone || '').trim()) fail('Completa nombre, RUT válido, correo y teléfono.');
    if (!fields.consent) fail('Debes aceptar el tratamiento de los datos de esta demostración.');
    if (String(fields.password || '').length < 8) fail('Usa una contraseña de prueba de al menos ocho caracteres.');
    if (state.users.some(u => u.email.toLowerCase() === email || (u.rut && normalizedRut(u.rut) === rut))) fail('Ya existe una cuenta con ese RUT o correo.');
    const salt = uid('salt'); const hash = await passwordHash(fields.password, salt);
    const u = { id: uid('p'), name: String(fields.name).trim(), email, rut, phone: String(fields.phone).trim(), role: 'Paciente', active: true, verified: false, demo: false, passwordHash: hash, salt, consentAt: Date.now(), failedAttempts: 0, lockedUntil: 0 };
    state.users.push(u); state.notifications.unshift({ id: uid('mail'), patientId: u.id, kind: 'Activación', status: 'Simulado', createdAt: Date.now(), attempts: 1 });
    audit(state, u.id, 'Registro de paciente', u.id); return u;
  }
  function activate(state, userId) { const u = user(state, userId); if (u.role !== 'Paciente') fail('La activación solo corresponde a pacientes.'); u.verified = true; audit(state, u.id, 'Activación de cuenta simulada', u.id); }
  function book(state, userId, slotId, now = Date.now()) {
    const u = actor(state, userId, ['Paciente']); const slot = findSlot(state, slotId);
    if (!u.verified) fail('Primero debes activar tu cuenta.');
    if (slot.blocked || activeBooking(state, slotId) || epochOf(slot.date, slot.time) <= now) fail('Ese horario ya no está disponible. Selecciona otro.');
    if (state.appointments.some(a => a.patientId === userId && a.status !== 'Anulada' && findSlot(state, a.slotId).date === slot.date && findSlot(state, a.slotId).time === slot.time)) fail('Ya tienes una cita en ese horario.');
    state.sequence.appointment++; const a = { id: uid('a'), code: 'GAL-' + state.sequence.appointment, patientId: userId, slotId, status: 'Reservada', createdAt: now, needsReschedule: false };
    state.appointments.push(a); notify(state, a, 'Confirmación', now); notify(state, a, 'Recordatorio', now); audit(state, userId, 'Reserva creada', a.code); return a;
  }
  function appointment(state, id) { return state.appointments.find(a => a.id === id) || fail('No se encontró la cita.'); }
  function paymentFor(state, id) { return state.payments.find(p => p.appointmentId === id); }
  function cancel(state, userId, id, now = Date.now()) {
    const u = actor(state, userId, ['Paciente', 'Secretaría']); const a = appointment(state, id); const slot = findSlot(state, a.slotId);
    if (['Anulada', 'Atendida'].includes(a.status)) fail('Esta cita no admite anulación.');
    if (u.role === 'Paciente') {
      if (a.patientId !== userId) fail('Solo puedes modificar tus propias citas.');
      if (paymentFor(state, id)) fail('Una cita pagada debe ser gestionada por secretaría.');
      if (epochOf(slot.date, slot.time) - now < 86400000) fail('La anulación requiere al menos veinticuatro horas de anticipación.');
    }
    a.status = 'Anulada'; a.needsReschedule = false; a.cancelledAt = now;
    if (paymentFor(state, id)) a.paymentReview = true;
    for (const n of state.notifications.filter(n => n.appointmentId === id && n.status === 'Programado')) n.status = 'Cancelado';
    notify(state, a, 'Anulación', now); audit(state, userId, 'Cita anulada', a.code, a.paymentReview ? 'Pago conservado; revisión administrativa pendiente' : 'Horario liberado'); return a;
  }
  function reschedule(state, userId, id, newSlotId, now = Date.now()) {
    const u = actor(state, userId, ['Paciente']); const a = appointment(state, id); const old = findSlot(state, a.slotId); const slot = findSlot(state, newSlotId);
    if (a.patientId !== u.id || a.status !== 'Reservada') fail('Solo puedes reagendar tus citas reservadas.');
    if (paymentFor(state, id)) fail('El cambio de una cita pagada requiere revisión de secretaría.');
    if (epochOf(old.date, old.time) - now < 86400000) fail('El reagendamiento requiere al menos veinticuatro horas de anticipación.');
    if (slot.id === old.id || slot.blocked || activeBooking(state, slot.id) || epochOf(slot.date, slot.time) <= now) fail('El nuevo horario ya no está disponible.');
    if (doctor(state, slot.doctorId).specialtyId !== doctor(state, old.doctorId).specialtyId) fail('Elige un horario de la misma especialidad.');
    if (state.appointments.some(x => x.id !== a.id && x.patientId === u.id && x.status !== 'Anulada' && findSlot(state, x.slotId).date === slot.date && findSlot(state, x.slotId).time === slot.time)) fail('Ya tienes otra cita en ese horario.');
    const previous = a.slotId; a.slotId = slot.id; a.needsReschedule = false; notify(state, a, 'Reagendamiento', now);
    for (const n of state.notifications.filter(n => n.appointmentId === id && n.status === 'Programado')) n.status = 'Cancelado';
    notify(state, a, 'Recordatorio', now); audit(state, userId, 'Cita reagendada', a.code, previous + ' → ' + slot.id); return a;
  }
  function addAvailability(state, userId, fields) {
    actor(state, userId, ['Secretaría']); const doc = doctor(state, fields.doctorId);
    const start = minutes(fields.start), end = minutes(fields.end), weekday = Number(fields.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || start < 0 || end > 1440 || end - start < state.settings.slotMinutes) fail('Revisa el día y el rango horario.');
    if (!doc.branchIds.includes(fields.branchId)) fail('El médico no está asignado a esa sucursal.');
    if (state.availability.some(b => b.doctorId === doc.id && b.weekday === weekday && start < minutes(b.end) && end > minutes(b.start))) fail('El bloque se solapa con otra disponibilidad del médico.');
    const block = { id: uid('av'), doctorId: doc.id, branchId: fields.branchId, weekday, start: fields.start, end: fields.end }; state.availability.push(block); audit(state, userId, 'Disponibilidad agregada', doc.name); return block;
  }
  function generateAgenda(state, userId, doctorId, start) {
    actor(state, userId, ['Secretaría']); if (!dateValid(start)) fail('Selecciona una fecha válida.');
    if (!state.availability.some(a => a.doctorId === doctorId)) fail('Registra disponibilidad antes de generar la agenda.');
    const count = generateSlots(state, doctorId, start, 3); audit(state, userId, 'Agenda trimestral generada', doctorId, `${count} horarios nuevos desde ${start}`); return count;
  }
  function affectedByBlock(state, doctorId, date, start, end) { return state.appointments.filter(a => a.status !== 'Anulada' && a.status !== 'Atendida').filter(a => { const s = findSlot(state, a.slotId); return s.doctorId === doctorId && s.date === date && minutes(s.time) >= minutes(start) && minutes(s.time) < minutes(end); }); }
  function modifyAgenda(state, userId, fields, confirmed = false) {
    actor(state, userId, ['Secretaría']); const doc = doctor(state, fields.doctorId);
    if (!dateValid(fields.date) || minutes(fields.start) >= minutes(fields.end)) fail('Revisa la fecha y el rango horario.');
    const affected = affectedByBlock(state, doc.id, fields.date, fields.start, fields.end);
    if (fields.mode === 'block') {
      if (affected.length && !confirmed) return { needsConfirmation: true, affected: affected.map(a => a.id) };
      for (const s of state.slots.filter(s => s.doctorId === doc.id && s.date === fields.date && minutes(s.time) >= minutes(fields.start) && minutes(s.time) < minutes(fields.end))) s.blocked = true;
      for (const a of affected) a.needsReschedule = true;
    } else {
      if (state.holidays.some(h => h.date === fields.date)) fail('El calendario base marca esa fecha como no laborable.');
      if (!doc.branchIds.includes(fields.branchId)) fail('El profesional no está asignado a esa sucursal.');
      const count = Math.floor((minutes(fields.end) - minutes(fields.start)) / state.settings.slotMinutes); if (!count) fail('El bloque debe contener al menos una atención completa.');
      for (let t = minutes(fields.start); t + state.settings.slotMinutes <= minutes(fields.end); t += state.settings.slotMinutes) {
        if (state.slots.some(s => s.doctorId === doc.id && s.date === fields.date && s.time === timeOf(t) && !s.blocked)) fail('Ese bloque se solapa con horarios existentes.');
      }
      for (let t = minutes(fields.start); t + state.settings.slotMinutes <= minutes(fields.end); t += state.settings.slotMinutes) {
        const time = timeOf(t), id = `${doc.id}_${fields.date}_${time}`; const s = state.slots.find(s => s.id === id);
        if (s) { s.blocked = false; s.branchId = fields.branchId; } else state.slots.push({ id, date: fields.date, time, doctorId: doc.id, branchId: fields.branchId, blocked: false });
      }
    }
    audit(state, userId, fields.mode === 'block' ? 'Bloqueo de agenda' : 'Bloque extraordinario agregado', doc.name, fields.date); return { needsConfirmation: false, affected: affected.map(a => a.id) };
  }
  function addHoliday(state, userId, date, name, confirmed = false) {
    actor(state, userId, ['Secretaría']); if (!dateValid(date) || !String(name).trim()) fail('Indica una fecha y un nombre.');
    if (state.holidays.some(h => h.date === date)) fail('Esa fecha ya está en el calendario base.');
    const affected = state.appointments.filter(a => !['Anulada', 'Atendida'].includes(a.status) && findSlot(state, a.slotId).date === date);
    if (affected.length && !confirmed) return { needsConfirmation: true, affected: affected.map(a => a.id) };
    state.holidays.push({ id: uid('h'), date, name: String(name).trim() });
    for (const s of state.slots.filter(s => s.date === date)) s.blocked = true;
    affected.forEach(a => { a.needsReschedule = true; }); audit(state, userId, 'Calendario base actualizado', date, name); return { needsConfirmation: false, affected: affected.map(a => a.id) };
  }
  function pay(state, userId, appointmentId, fields, now = Date.now()) {
    actor(state, userId, ['Cajero']); const a = appointment(state, appointmentId); const slot = findSlot(state, a.slotId);
    if (a.status !== 'Reservada' || paymentFor(state, a.id)) fail('Esta cita no admite un nuevo pago.');
    if (a.needsReschedule || slot.blocked) fail('Secretaría debe resolver el cambio de agenda antes de cobrar.');
    const amount = Number(fields.amount); if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10000000) fail('Ingresa un monto válido en pesos enteros.');
    if (!['Efectivo', 'Tarjeta', 'Documento', 'Bono Fonasa', 'Bono Isapre'].includes(fields.method)) fail('Selecciona un medio de pago.');
    if (fields.method.startsWith('Bono') && (!fields.bonoValid || !String(fields.bonoFolio || '').trim())) fail('Bono inválido o sin folio. Selecciona otro medio o valida el documento.');
    if (fields.method.startsWith('Bono') && state.payments.some(p => p.bonoFolio === String(fields.bonoFolio).trim())) fail('Ese folio de bono ya fue utilizado.');
    const doc = doctor(state, slot.doctorId); const date = today(now); state.sequence.payment++;
    const p = { id: uid('pay'), folio: 'REC-' + state.sequence.payment, appointmentId: a.id, doctorId: doc.id, branchId: slot.branchId, date, amount,
      base: baseFor(state, doc.specialtyId, date), rate: rateFor(state, doc.id, date), method: fields.method, bonoFolio: fields.bonoFolio ? String(fields.bonoFolio).trim() : '', at: now, recordedBy: userId };
    if (p.base == null || p.rate == null) fail('Falta configurar la hora base o el porcentaje vigente.');
    state.payments.push(p); a.status = 'En espera'; audit(state, userId, 'Pago presencial registrado', p.folio, `${amount} CLP / ${p.method}`); return p;
  }
  function waiting(state, userId, date = today()) {
    const u = actor(state, userId, ['Médico']); return state.appointments.filter(a => a.status === 'En espera' && paymentFor(state, a.id)).filter(a => { const s = findSlot(state, a.slotId); return s.doctorId === u.doctorId && s.date === date; }).sort((a, b) => findSlot(state, a.slotId).time.localeCompare(findSlot(state, b.slotId).time));
  }
  function attend(state, userId, id, date = today()) {
    if (!waiting(state, userId, date).some(a => a.id === id)) fail('Solo puedes marcar pacientes de tu lista de espera de hoy.');
    const a = appointment(state, id); a.status = 'Atendida'; a.attendedAt = Date.now(); audit(state, userId, 'Atención finalizada', a.code); return a;
  }
  function revenue(state, userId, filters = {}) {
    actor(state, userId, ['Secretaría', 'Administrador']); const rows = state.payments.filter(p => (!filters.from || p.date >= filters.from) && (!filters.to || p.date <= filters.to) && (!filters.doctorId || p.doctorId === filters.doctorId) && (!filters.branchId || p.branchId === filters.branchId));
    return { rows, total: rows.reduce((sum, p) => sum + p.amount, 0), count: rows.length };
  }
  function configureFinance(state, userId, type, id, value, from) {
    actor(state, userId, ['Administrador']); value = Number(value); if (!dateValid(from)) fail('Selecciona una fecha de vigencia.');
    if (type === 'base' && (!Number.isSafeInteger(value) || value <= 0 || value > 10000000)) fail('Ingresa una hora base válida en pesos enteros.');
    if (type === 'rate' && (!Number.isFinite(value) || value < 0 || value > 100 || Math.abs(Math.round(value * 100) - value * 100) > 0.0000001)) fail('El porcentaje debe estar entre 0 y 100, con hasta dos decimales.');
    const obj = type === 'base' ? specialty(state, id) : doctor(state, id); const history = type === 'base' ? obj.baseHistory : obj.rateHistory;
    const at = history.find(h => h.from === from); if (at) at.value = value; else history.push({ from, value });
    audit(state, userId, type === 'base' ? 'Hora base configurada' : 'Porcentaje configurado', obj.name, `${value} desde ${from}; periodos cerrados conservados`);
  }
  function calculateCommission(state, userId, doctorId, period) {
    actor(state, userId, ['Administrador']); doctor(state, doctorId); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) fail('Selecciona un periodo mensual válido.');
    const existing = state.commissions.find(c => c.doctorId === doctorId && c.period === period);
    if (existing?.closed) fail('El periodo está cerrado. Su cálculo original no puede cambiar.');
    const payments = state.payments.filter(p => p.doctorId === doctorId && p.date.startsWith(period));
    const lines = payments.map(p => ({ paymentId: p.id, appointmentId: p.appointmentId, date: p.date, collected: p.amount, base: p.base, rate: p.rate, commission: Math.round(p.base * Math.round(p.rate * 100) / 10000) }));
    const result = { id: existing?.id || uid('com'), doctorId, period, formula: 'Hora base por especialidad × porcentaje por atención', lines, collected: lines.reduce((s, l) => s + l.collected, 0), calculated: lines.reduce((s, l) => s + l.commission, 0), adjustments: existing?.adjustments || [], status: 'Calculada', closed: false, calculatedAt: Date.now(), calculatedBy: userId };
    if (existing) state.commissions[state.commissions.indexOf(existing)] = result; else state.commissions.push(result);
    audit(state, userId, 'Comisión calculada', result.id, `${period} / RF 19`); return result;
  }
  const totalCommission = c => c.calculated + c.adjustments.reduce((s, a) => s + a.amount, 0);
  function issueCommission(state, userId, id) {
    actor(state, userId, ['Secretaría']); const c = state.commissions.find(c => c.id === id) || fail('Primero administración debe calcular la comisión.');
    if (c.closed) return c;
    const current = state.payments.filter(p => p.doctorId === c.doctorId && p.date.startsWith(c.period));
    if (current.length !== c.lines.length || current.some(p => !c.lines.some(l => l.paymentId === p.id))) fail('Hay nuevos pagos en el periodo. Solicita recalcular antes de emitir.');
    state.sequence.commission++; c.folio = 'COM-' + state.sequence.commission; c.closed = true; c.status = 'Pendiente'; c.issuedAt = Date.now();
    audit(state, userId, 'Comprobante emitido y periodo cerrado', c.folio); return c;
  }
  function adjustCommission(state, userId, id, amount, reason) {
    actor(state, userId, ['Administrador']); const c = state.commissions.find(c => c.id === id) || fail('No se encontró la comisión.'); amount = Number(amount);
    if (c.status === 'Pagada') fail('La comisión pagada requiere una conciliación posterior; no admite ajustes en esta versión.');
    if (!Number.isSafeInteger(amount) || amount === 0 || !String(reason).trim()) fail('Indica un ajuste en pesos y un motivo obligatorio.');
    if (totalCommission(c) + amount < 0) fail('El ajuste no puede dejar una comisión negativa.');
    c.adjustments.push({ id: uid('adj'), amount, reason: String(reason).trim(), by: userId, at: Date.now() }); audit(state, userId, 'Ajuste de comisión registrado', c.folio || c.id, `${amount} CLP / ${reason}`); return c;
  }
  function payCommission(state, userId, id, reference) {
    actor(state, userId, ['Secretaría']); const c = state.commissions.find(c => c.id === id) || fail('No se encontró la comisión.');
    if (!c.closed || c.status === 'Pagada') fail('Solo puedes registrar pagos de comprobantes pendientes.');
    if (!String(reference).trim()) fail('Ingresa la referencia del comprobante de transferencia o depósito.');
    c.status = 'Pagada'; c.paymentReference = String(reference).trim(); c.paidAt = Date.now(); audit(state, userId, 'Pago de comisión registrado', c.folio, c.paymentReference); return c;
  }
  function staffUser(state, userId, fields) {
    actor(state, userId, ['Administrador']); const email = String(fields.email || '').trim().toLowerCase();
    if (!String(fields.name || '').trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !ROLES.filter(r => r !== 'Paciente').includes(fields.role)) fail('Completa nombre, correo y rol del personal.');
    if (state.users.some(u => u.email.toLowerCase() === email)) fail('Ese correo ya está registrado.');
    if (fields.role === 'Médico') doctor(state, fields.doctorId);
    const u = { id: uid('u'), name: String(fields.name).trim(), email, role: fields.role, doctorId: fields.role === 'Médico' ? fields.doctorId : undefined, active: true, verified: true, demo: true, failedAttempts: 0, lockedUntil: 0, twoFactor: false };
    state.users.push(u); audit(state, userId, 'Usuario del personal creado', u.id, u.role); return u;
  }
  function updateUser(state, userId, id, fields) {
    actor(state, userId, ['Administrador']); const u = user(state, id);
    if (u.role === 'Paciente' && fields.role && fields.role !== 'Paciente') fail('Las cuentas de pacientes se mantienen separadas del personal.');
    if (u.id === userId && (fields.active === false || (fields.role && fields.role !== 'Administrador'))) fail('Conserva tu cuenta administradora activa para evitar perder acceso.');
    if (fields.role && !ROLES.includes(fields.role)) fail('Rol no válido.');
    if (fields.role === 'Médico' && !u.doctorId) fail('Crea una cuenta de médico asociada a un profesional.');
    if ('active' in fields) u.active = !!fields.active; if (fields.role) u.role = fields.role;
    if ('twoFactor' in fields && ['Administrador', 'Cajero'].includes(u.role)) u.twoFactor = !!fields.twoFactor;
    audit(state, userId, 'Usuario actualizado', u.id, `${u.role} / ${u.active ? 'Activo' : 'Inactivo'}`); return u;
  }
  function unlock(state, userId, id) { actor(state, userId, ['Administrador']); const u = user(state, id); u.failedAttempts = 0; u.lockedUntil = 0; audit(state, userId, 'Cuenta desbloqueada', id); }
  function addBranch(state, userId, fields) {
    actor(state, userId, ['Administrador']); const name = String(fields.name || '').trim();
    if (!name || state.branches.some(b => b.name.toLowerCase() === name.toLowerCase())) fail('Indica un nombre nuevo para la sucursal.');
    const ids = fields.doctorIds || []; ids.forEach(id => doctor(state, id));
    const b = { id: uid('b'), name, address: String(fields.address || 'Sede de demostración').trim(), active: true };
    state.branches.push(b); ids.forEach(id => doctor(state, id).branchIds.push(b.id)); audit(state, userId, 'Sucursal creada por configuración', b.name); return b;
  }
  function processNotifications(state, userId, mode = 'success', now = Date.now()) {
    actor(state, userId, ['Secretaría']); let count = 0;
    for (const n of state.notifications.filter(n => n.status === 'Programado' && n.dueAt <= now)) {
      n.attempts++;
      if (mode === 'success') n.status = 'Simulado'; else if (n.attempts >= 4) n.status = 'Fallido';
      count++;
    }
    audit(state, userId, 'Simulación de notificaciones procesada', 'Bandeja', mode === 'success' ? 'Entrega simulada; no se envió correo real' : 'Fallo simulado'); return count;
  }
  function retryNotification(state, userId, id, success) {
    actor(state, userId, ['Secretaría']); const n = state.notifications.find(n => n.id === id) || fail('No se encontró la notificación.');
    if (n.attempts >= 4) fail('Se agotaron los tres reintentos. La alerta requiere revisión manual.');
    n.attempts++; n.status = success ? 'Simulado' : n.attempts >= 4 ? 'Fallido' : 'Programado'; n.dueAt = Date.now(); return n;
  }
  const API = { VERSION, DEMO_PASSWORD, ROLES, clone, uid, today, addDays, addMonths, epochOf, dateValid, minutes, timeOf, actor, audit, doctor, specialty, user, effective, baseFor, rateFor, activeBooking, available, findSlot, createSeed, passwordHash, authenticate, verifyTwoFactor, normalizedRut, validRut, register, activate, book, appointment, paymentFor, cancel, reschedule, addAvailability, generateAgenda, affectedByBlock, modifyAgenda, addHoliday, pay, waiting, attend, revenue, configureFinance, calculateCommission, totalCommission, issueCommission, adjustCommission, payCommission, staffUser, updateUser, unlock, addBranch, processNotifications, retryNotification };
  root.Galenos = API; if (typeof module !== 'undefined') module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : window);
