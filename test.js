import test from 'ava';
import delay from 'delay';
import PCancelable from 'p-cancelable';
import m from '.';

const fixture = Symbol('fixture');
const fixtureErr = new Error('fixture');

test('resolves before timeout', async t => {
	t.is(await m(delay(50).then(() => fixture), 200), fixture);
});

test('throws when ms is not number', async t => {
	await t.throws(m(delay(50), '200'), TypeError);
});

test('throws when ms is negative number', async t => {
	await t.throws(m(delay(50), -1), TypeError);
});

test('rejects after timeout', async t => {
	await t.throws(m(delay(200), 50), m.TimeoutError);
});

test('rejects before timeout if specified promise rejects', async t => {
	await t.throws(m(delay(50).then(() => Promise.reject(fixtureErr)), 200), fixtureErr.message);
});

test('fallback argument', async t => {
	await t.throws(m(delay(200), 50, 'rainbow'), 'rainbow');
	await t.throws(m(delay(200), 50, new RangeError('cake')), RangeError);
	await t.throws(m(delay(200), 50, () => Promise.reject(fixtureErr)), fixtureErr.message);
	await t.throws(m(delay(200), 50, () => {
		throw new RangeError('cake');
	}), RangeError);
});

test('calls `.cancel()` on promise when it exists', async t => {
	const p = new PCancelable(onCancel => {
		onCancel(() => {
			t.pass();
		});

		return delay(200);
	});

	await t.throws(m(p, 50), m.TimeoutError);
	t.true(p.canceled);
});
