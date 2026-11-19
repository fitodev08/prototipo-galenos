const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../Aplicacion/domain.js');
const day = '2026-11-14';
const now = D.epochOf('2026-11-13', '12:00');
const fresh = () => D.createSeed(day);
const first = (s, filters = {}) => D.available(s, filters, now)[0];

test('RF05: una reserva retira el horario y rechaza un segundo paciente sin crear otra cita', () => {
  const s = fresh(), slot = first(s, { doctorId: 'd1' }); const a = D.book(s, 'p1', slot.id, now); const count = s.appointments.length;
  assert.equal(a.status, 'Reservada'); assert.ok(!D.available(s, {}, now).some(x => x.id === slot.id));
  assert.throws(() => D.book(s, 'p2', slot.id, now), /no está disponible/); assert.equal(s.appointments.length, count);
});
test('RF01: los roles no autorizados no reservan ni registran pagos', () => {
  const s = fresh(); assert.throws(() => D.book(s, 'u2', first(s).id, now), /permiso/);
  assert.throws(() => D.pay(s, 'p1', 'a1001', { amount: 28000, method: 'Efectivo' }, now), /permiso/);
});
test('RF06: límite de 24 horas inclusivo, liberación y rechazo de menos de 24 horas', () => {
  const s = fresh(), a = D.appointment(s, 'a1004'), slot = D.findSlot(s, a.slotId), t = D.epochOf(slot.date, slot.time);
  assert.throws(() => D.cancel(s, 'p1', a.id, t - 86399999), /veinticuatro/); assert.equal(a.status, 'Reservada');
  D.cancel(s, 'p1', a.id, t - 86400000); assert.equal(a.status, 'Anulada'); assert.equal(D.activeBooking(s, slot.id), undefined);
});
test('RF06: el paciente no anula una cita ajena ni una cita pagada; secretaría conserva el pago', () => {
  const s = fresh(); assert.throws(() => D.cancel(s, 'p1', 'a1002', now), /propias/);
  assert.throws(() => D.cancel(s, 'p2', 'a1002', now), /pagada/);
  const count = s.payments.length; D.cancel(s, 'u1', 'a1002', now); assert.equal(s.payments.length, count); assert.equal(D.appointment(s, 'a1002').paymentReview, true);
});
test('RF17: reagendar cambia la ocupación en una operación y conserva el código de reserva', () => {
  const s = fresh(), a = D.appointment(s, 'a1004'), old = a.slotId, code = a.code;
  const target = first(s, { doctorId: 'd3', patientId: 'p1' }); D.reschedule(s, 'p1', a.id, target.id, now);
  assert.equal(a.slotId, target.id); assert.equal(a.code, code); assert.equal(D.activeBooking(s, old), undefined); assert.equal(D.activeBooking(s, target.id).id, a.id);
});
test('RF17: el fallo por especialidad o por ocupación no libera la reserva original', () => {
  const s = fresh(), a = D.appointment(s, 'a1004'), old = a.slotId;
  assert.throws(() => D.reschedule(s, 'p1', a.id, first(s, { doctorId: 'd1' }).id, now), /misma especialidad/);
  const target = first(s, { doctorId: 'd3' }); D.book(s, 'p2', target.id, now);
  assert.throws(() => D.reschedule(s, 'p1', a.id, target.id, now), /no está disponible/); assert.equal(a.slotId, old);
});
test('RF02: se rechazan bloques solapados aunque intenten usar otra sucursal', () => {
  const s = fresh(), count = s.availability.length;
  assert.throws(() => D.addAvailability(s, 'u1', { doctorId: 'd2', branchId: 'b2', weekday: 1, start: '10:00', end: '12:00' }), /solapa/);
  assert.equal(s.availability.length, count);
  D.addAvailability(s, 'u1', { doctorId: 'd2', branchId: 'b2', weekday: 1, start: '15:00', end: '17:00' }); assert.equal(s.availability.length, count + 1);
});
test('RF03: generación trimestral idempotente y sin horarios disponibles en días no laborables', () => {
  const s = fresh(), count = s.slots.length; assert.equal(D.generateAgenda(s, 'u1', 'd1', day), 0); assert.equal(s.slots.length, count);
  const holiday = s.holidays[0].date; assert.equal(D.available(s, { date: holiday }, now).length, 0);
  assert.ok(s.slots.some(slot => slot.date >= D.addMonths(day, 2)));
});
test('RF04: se solicitan confirmaciones y las reservas afectadas quedan identificadas', () => {
  const s = fresh(), f = { doctorId: 'd1', date: day, start: '09:00', end: '11:00', mode: 'block' };
  const result = D.modifyAgenda(s, 'u1', f); assert.equal(result.needsConfirmation, true); assert.equal(D.appointment(s, 'a1001').needsReschedule, false);
  D.modifyAgenda(s, 'u1', f, true); assert.equal(D.appointment(s, 'a1001').needsReschedule, true);
  assert.throws(() => D.pay(s, 'u2', 'a1001', { amount: 28000, method: 'Efectivo' }, now), /resolver el cambio/);
});
test('RF03/04: agregar un día no laborable con reservas exige confirmación', () => {
  const s = fresh(); const result = D.addHoliday(s, 'u1', day, 'Cierre de prueba'); assert.equal(result.needsConfirmation, true);
  assert.equal(s.holidays.some(h => h.date === day), false); D.addHoliday(s, 'u1', day, 'Cierre de prueba', true);
  assert.equal(D.available(s, { date: day }, now).length, 0); assert.equal(D.appointment(s, 'a1001').needsReschedule, true);
});
test('RF08: un bono inválido no crea pago ni cambia el estado del paciente', () => {
  const s = fresh(), count = s.payments.length;
  assert.throws(() => D.pay(s, 'u2', 'a1001', { amount: 28000, method: 'Bono Fonasa', bonoFolio: 'B-01', bonoValid: false }, now), /Bono inválido/);
  assert.equal(s.payments.length, count); assert.equal(D.appointment(s, 'a1001').status, 'Reservada');
});
test('RF08: pago con folio único, auditoría, estado en espera y rechazo del duplicado', () => {
  const s = fresh(), p = D.pay(s, 'u2', 'a1001', { amount: 28000, method: 'Bono Fonasa', bonoFolio: 'B-01', bonoValid: true }, D.epochOf(day, '08:00'));
  assert.ok(p.folio); assert.equal(D.appointment(s, 'a1001').status, 'En espera'); assert.ok(s.audit.some(a => a.target === p.folio));
  assert.throws(() => D.pay(s, 'u2', 'a1001', { amount: 28000, method: 'Efectivo' }, now), /nuevo pago/);
});
test('RF09: el médico ve solo su lista pagada del día y no marca pacientes ajenos', () => {
  const s = fresh(); const rows = D.waiting(s, 'u3', day); assert.deepEqual(rows.map(a => a.id), ['a1002']);
  assert.throws(() => D.attend(s, 'u3', 'a1001', day), /tu lista/); assert.throws(() => D.attend(s, 'u3', 'a1003', day), /tu lista/);
  D.attend(s, 'u3', 'a1002', day); assert.equal(D.waiting(s, 'u3', day).length, 0);
});
test('RF10: los filtros de recaudación concilian exactamente con los pagos de caja', () => {
  const s = fresh(), r = D.revenue(s, 'u4', { from: day, to: day, doctorId: 'd1' }); assert.equal(r.count, 1); assert.equal(r.total, 28000);
  assert.equal(D.revenue(s, 'u1', { from: '2020-01-01', to: '2020-01-02' }).total, 0);
});
test('RF19: la comisión utiliza la hora base por especialidad y no el monto cobrado', () => {
  const s = fresh(); D.pay(s, 'u2', 'a1001', { amount: 20000, method: 'Efectivo' }, D.epochOf(day, '08:00'));
  const c = D.calculateCommission(s, 'u4', 'd1', '2026-11'); assert.equal(c.collected, 48000); assert.equal(c.calculated, 11200);
  assert.equal(c.lines.find(l => l.appointmentId === 'a1001').commission, 5600);
});
test('RF14/19: vigencias futuras y cambios de configuración conservan los periodos emitidos', () => {
  const s = fresh(), c = D.calculateCommission(s, 'u4', 'd1', '2026-11'); D.issueCommission(s, 'u1', c.id); const original = D.clone(c);
  D.configureFinance(s, 'u4', 'base', 's1', 99999, '2026-12-01'); D.configureFinance(s, 'u4', 'rate', 'd1', 25.13, '2026-12-01');
  assert.equal(D.baseFor(s, 's1', day), 28000); assert.equal(D.baseFor(s, 's1', '2026-12-02'), 99999); assert.deepEqual(c, original);
  assert.throws(() => D.calculateCommission(s, 'u4', 'd1', '2026-11'), /cerrado/);
});
test('RF11: secretaría no emite un cálculo desactualizado después de un nuevo pago', () => {
  const s = fresh(), c = D.calculateCommission(s, 'u4', 'd1', '2026-11'); D.pay(s, 'u2', 'a1001', { amount: 28000, method: 'Efectivo' }, D.epochOf(day, '08:00'));
  assert.throws(() => D.issueCommission(s, 'u1', c.id), /nuevos pagos/); assert.equal(c.closed, false);
});
test('RF18/12: ajuste con motivo, cálculo original conservado y registro de pago informativo', () => {
  const s = fresh(), c = D.calculateCommission(s, 'u4', 'd1', '2026-11'); D.issueCommission(s, 'u1', c.id); const initial = c.calculated;
  assert.throws(() => D.adjustCommission(s, 'u4', c.id, -100, ''), /motivo/);
  D.adjustCommission(s, 'u4', c.id, -100, 'Corrección de prueba'); assert.equal(c.calculated, initial); assert.equal(D.totalCommission(c), initial - 100);
  assert.throws(() => D.payCommission(s, 'u1', c.id, ''), /referencia/); D.payCommission(s, 'u1', c.id, 'DEP-PRUEBA-1'); assert.equal(c.status, 'Pagada');
  assert.throws(() => D.payCommission(s, 'u1', c.id, 'DEP-PRUEBA-2'), /pendientes/);
});
test('RF15: usuarios desactivados no ingresan y un administrador no pierde su propio acceso', async () => {
  const s = fresh(); D.updateUser(s, 'u4', 'u2', { active: false }); await assert.rejects(D.authenticate(s, 'caja@galenos.example', D.DEMO_PASSWORD, now), /desactivada/);
  assert.throws(() => D.updateUser(s, 'u4', 'u4', { active: false }), /cuenta administradora/);
});
test('RF01: cinco intentos bloquean quince minutos y al vencer el plazo se permite el acceso', async () => {
  const s = fresh(); for (let i = 0; i < 5; i++) await assert.rejects(D.authenticate(s, 'caja@galenos.example', 'incorrecta', now));
  assert.equal(D.user(s, 'u2').lockedUntil, now + 900000); await assert.rejects(D.authenticate(s, 'caja@galenos.example', D.DEMO_PASSWORD, now + 1000), /bloqueada/);
  const result = await D.authenticate(s, 'caja@galenos.example', D.DEMO_PASSWORD, now + 900001); assert.equal(result.userId, 'u2');
});
test('Soporte RF01: desbloqueo manual autorizado y auditado', async () => {
  const s = fresh(); D.user(s, 'u2').lockedUntil = now + 900000; D.unlock(s, 'u4', 'u2');
  assert.equal((await D.authenticate(s, 'caja@galenos.example', D.DEMO_PASSWORD, now)).userId, 'u2'); assert.ok(s.audit.some(a => a.action === 'Cuenta desbloqueada'));
});
test('RNF09: el flujo exige el segundo factor habilitado y rechaza códigos incorrectos', async () => {
  const s = fresh(); D.updateUser(s, 'u4', 'u2', { twoFactor: true }); const result = await D.authenticate(s, 'caja@galenos.example', D.DEMO_PASSWORD, now);
  assert.equal(result.needsTwoFactor, true); assert.throws(() => D.verifyTwoFactor(s, 'u2', '000000'), /incorrecto/); assert.equal(D.verifyTwoFactor(s, 'u2', '246810'), true);
});
test('RF13: registro con hash, consentimiento, unicidad y activación previa al acceso', async () => {
  const s = fresh(); const f = { name: 'Paciente de prueba', rut: '12345678-5', email: 'prueba@galenos.example', phone: '900000003', password: 'PruebaSegura!', consent: true };
  assert.equal(D.validRut(f.rut), true); await assert.rejects(D.register(s, { ...f, consent: false }), /aceptar/);
  const p = await D.register(s, f); assert.equal(p.verified, false); assert.equal('password' in p, false); assert.ok(p.passwordHash);
  await assert.rejects(D.authenticate(s, f.email, f.password), /Activa/); await assert.rejects(D.register(s, f), /Ya existe/);
  D.activate(s, p.id); assert.equal((await D.authenticate(s, f.email, f.password)).userId, p.id);
});
test('RF16: sucursal y asignación de profesionales por configuración', () => {
  const s = fresh(), b = D.addBranch(s, 'u4', { name: 'Sucursal de prueba', doctorIds: ['d1'] });
  assert.ok(D.doctor(s, 'd1').branchIds.includes(b.id)); D.addAvailability(s, 'u1', { doctorId: 'd1', branchId: b.id, weekday: 1, start: '15:00', end: '17:00' });
  D.generateAgenda(s, 'u1', 'd1', day); assert.ok(D.available(s, { branchId: b.id }, now).length > 0);
});
test('RF07: recordatorio a 24 horas, tres reintentos y alerta final', () => {
  const s = fresh(), n = s.notifications.find(n => n.appointmentId === 'a1004'), slot = D.findSlot(s, D.appointment(s, 'a1004').slotId);
  assert.equal(n.dueAt, D.epochOf(slot.date, slot.time) - 86400000);
  D.processNotifications(s, 'u1', 'failure', n.dueAt); assert.equal(n.attempts, 1);
  for (let i = 0; i < 3; i++) D.retryNotification(s, 'u1', n.id, false);
  assert.equal(n.attempts, 4); assert.equal(n.status, 'Fallido'); assert.throws(() => D.retryNotification(s, 'u1', n.id, true), /agotaron/);
});
test('Fechas: conversión horaria de Santiago y fin de mes correcto', () => {
  assert.equal(new Date(D.epochOf('2026-11-14', '09:00')).toISOString(), '2026-11-14T12:00:00.000Z');
  assert.equal(D.addMonths('2026-01-31', 1), '2026-02-28');
});
