import test from 'ava';
import delay from 'delay';
import PCancelable from 'p-cancelable';
import inRange from 'in-range';
import timeSpan from 'time-span';
import pTimeout, {TimeoutError} from './index.js';

const fixture = Symbol('fixture');
const fixtureError = new Error('fixture');

test('resolves before timeout', async t => {
	t.is(await pTimeout(delay(50).then(() => fixture), 200), fixture);
});

test('throws when milliseconds is not number', async t => {
	await t.throwsAsync(pTimeout(delay(50), '200'), {instanceOf: TypeError});
});

test('throws when milliseconds is negative number', async t => {
	await t.throwsAsync(pTimeout(delay(50), -1), {instanceOf: TypeError});
});

test('throws when milliseconds is NaN', async t => {
	await t.throwsAsync(pTimeout(delay(50), Number.NaN), {instanceOf: TypeError});
});

test('handles milliseconds being `Infinity`', async t => {
	t.is(
		await pTimeout(delay(50, {value: fixture}), Number.POSITIVE_INFINITY),
		fixture
	);
});

test('rejects after timeout', async t => {
	await t.throwsAsync(pTimeout(delay(200), 50), {instanceOf: TimeoutError});
});

test('rejects before timeout if specified promise rejects', async t => {
	await t.throwsAsync(pTimeout(delay(50).then(() => Promise.reject(fixtureError)), 200), {message: fixtureError.message});
});

test('fallback argument', async t => {
	await t.throwsAsync(pTimeout(delay(200), 50, 'rainbow'), {message: 'rainbow'});
	await t.throwsAsync(pTimeout(delay(200), 50, new RangeError('cake')), {instanceOf: RangeError});
	await t.throwsAsync(pTimeout(delay(200), 50, () => Promise.reject(fixtureError)), {message: fixtureError.message});
	await t.throwsAsync(pTimeout(delay(200), 50, () => {
		throw new RangeError('cake');
	}), {instanceOf: RangeError});
});

test('calls `.cancel()` on promise when it exists', async t => {
	const promise = new PCancelable(async (resolve, reject, onCancel) => {
		onCancel(() => {
			t.pass();
		});

		await delay(200);
		resolve();
	});

	await t.throwsAsync(pTimeout(promise, 50), {instanceOf: TimeoutError});
	t.true(promise.isCanceled);
});

test('accepts `customTimers` option', async t => {
	t.plan(2);

	await pTimeout(delay(50), 123, undefined, {
		customTimers: {
			setTimeout(fn, milliseconds) {
				t.is(milliseconds, 123);
				return setTimeout(fn, milliseconds);
			},
			clearTimeout(timeoutId) {
				t.pass();
				return clearTimeout(timeoutId);
			}
		}
	});
});

test('`.clear()` method', async t => {
	const end = timeSpan();
	const promise = pTimeout(delay(300), 200);

	promise.clear();

	await promise;
	t.true(inRange(end(), {start: 0, end: 350}));
});
