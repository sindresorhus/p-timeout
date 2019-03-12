import test from 'ava';
import delay from 'delay';
import PCancelable from 'p-cancelable';
import pTimeout from '.';

const fixture = Symbol('fixture');
const fixtureError = new Error('fixture');

test('resolves before timeout', async t => {
	t.is(await pTimeout(delay(50).then(() => fixture), 200), fixture);
});

test('throws when milliseconds is not number', async t => {
	await t.throwsAsync(pTimeout(delay(50), '200'), TypeError);
});

test('throws when milliseconds is negative number', async t => {
	await t.throwsAsync(pTimeout(delay(50), -1), TypeError);
});

test('rejects after timeout', async t => {
	await t.throwsAsync(pTimeout(delay(200), 50), pTimeout.TimeoutError);
});

test('rejects before timeout if specified promise rejects', async t => {
	await t.throwsAsync(pTimeout(delay(50).then(() => Promise.reject(fixtureError)), 200), fixtureError.message);
});

test('fallback argument', async t => {
	await t.throwsAsync(pTimeout(delay(200), 50, 'rainbow'), 'rainbow');
	await t.throwsAsync(pTimeout(delay(200), 50, new RangeError('cake')), RangeError);
	await t.throwsAsync(pTimeout(delay(200), 50, () => Promise.reject(fixtureError)), fixtureError.message);
	await t.throwsAsync(pTimeout(delay(200), 50, () => {
		throw new RangeError('cake');
	}), RangeError);
});

test('calls `.cancel()` on promise when it exists', async t => {
	const promise = new PCancelable(async (resolve, reject, onCancel) => {
		onCancel(() => {
			t.pass();
		});

		await delay(200);
		resolve();
	});

	await t.throwsAsync(pTimeout(promise, 50), pTimeout.TimeoutError);
	t.true(promise.isCanceled);
});
