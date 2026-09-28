import process from 'node:process';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import delay from 'delay';
import PCancelable from 'p-cancelable';
import inRange from 'in-range';
import timeSpan from 'time-span';
import sinon from 'sinon';
import pTimeout, {TimeoutError} from './index.js';

const fixture = Symbol('fixture');
const fixtureError = new Error('fixture');

const captureRejection = async promise => {
	try {
		await promise;
	} catch (error) {
		return error;
	}

	return undefined;
};

test('resolves before timeout', async () => {
	assert.strictEqual(await pTimeout(delay(50, {value: fixture}), {milliseconds: 200}), fixture);
});

test('throws when milliseconds is not number', async () => {
	await assert.rejects(pTimeout(delay(50), {milliseconds: '200'}), TypeError);
});

test('throws when milliseconds is negative number', async () => {
	await assert.rejects(pTimeout(delay(50), {milliseconds: -1}), TypeError);
});

test('throws when milliseconds is NaN', async () => {
	await assert.rejects(pTimeout(delay(50), {milliseconds: NaN}), TypeError);
});

test('handles milliseconds being `Infinity`', async () => {
	assert.strictEqual(
		await pTimeout(delay(50, {value: fixture}), {milliseconds: Infinity}),
		fixture,
	);
});

test('rejects after timeout', async () => {
	await assert.rejects(pTimeout(delay(200), {milliseconds: 50}), TimeoutError);
});

test('resolves after timeout with message:false', async () => {
	assert.strictEqual(
		await pTimeout(delay(200), {milliseconds: 50, message: false}),
		undefined,
	);
});

test('rejects before timeout if specified promise rejects', async () => {
	const rejectingPromise = async () => {
		await delay(50);
		throw fixtureError;
	};

	await assert.rejects(pTimeout(rejectingPromise(), {milliseconds: 200}), {message: fixtureError.message});
});

test('fallback argument', async () => {
	await assert.rejects(pTimeout(delay(200), {milliseconds: 50, message: 'rainbow'}), {message: 'rainbow'});
	await assert.rejects(pTimeout(delay(200), {milliseconds: 50, message: new RangeError('cake')}), RangeError);
	await assert.rejects(pTimeout(delay(200), {milliseconds: 50, fallback: () => Promise.reject(fixtureError)}), {message: fixtureError.message});
	await assert.rejects(pTimeout(delay(200), {
		milliseconds: 50,
		fallback() {
			throw new RangeError('cake');
		},
	}), RangeError);
});

test('calls `.cancel()` on promise when it exists', async () => {
	let didCancel = false;
	const promise = new PCancelable(async (resolve, reject, onCancel) => {
		onCancel(() => {
			didCancel = true;
		});

		await delay(200);
		resolve();
	});

	await assert.rejects(pTimeout(promise, {milliseconds: 50}), TimeoutError);
	assert.ok(didCancel, '`.cancel()` should have been called on the promise');
	assert.ok(promise.isCanceled);
});

test('accepts `customTimers` option', async () => {
	const requestedDelays = [];
	let didClear = false;

	await pTimeout(delay(50), {
		milliseconds: 123,
		customTimers: {
			setTimeout(fn, milliseconds) {
				requestedDelays.push(milliseconds);
				return setTimeout(fn, milliseconds);
			},
			clearTimeout(timeoutId) {
				didClear = true;
				return clearTimeout(timeoutId);
			},
		},
	});

	assert.deepEqual(requestedDelays, [123]);
	assert.ok(didClear, '`clearTimeout` should have been called once the promise settled');
});

test('`.clear()` method', async () => {
	const end = timeSpan();
	const promise = pTimeout(delay(300), {milliseconds: 200});

	promise.clear();

	await promise;
	assert.ok(inRange(end(), {start: 0, end: 350}));
});

test('`.clear()` method can be called multiple times', async () => {
	const promise = pTimeout(delay(50, {value: fixture}), {milliseconds: 200});

	promise.clear();
	promise.clear(); // Should not throw

	assert.strictEqual(await promise, fixture);
});

test('fallback resolves successfully', async () => {
	const result = await pTimeout(delay(200), {
		milliseconds: 50,
		fallback: () => 'fallback result',
	});

	assert.strictEqual(result, 'fallback result');
});

// AbortController tests
test('rejects when calling `AbortController#abort()`', async () => {
	const abortController = new AbortController();

	const promise = pTimeout(delay(3000), {
		milliseconds: 2000,
		signal: abortController.signal,
	});

	abortController.abort();

	const error = await captureRejection(promise);
	assert.strictEqual(error?.name, 'AbortError');
	assert.ok(error instanceof DOMException);
});

test('already aborted signal', async () => {
	const abortController = new AbortController();

	abortController.abort();

	const promise = pTimeout(delay(3000), {
		milliseconds: 2000,
		signal: abortController.signal,
	});

	const error = await captureRejection(promise);
	assert.strictEqual(error?.name, 'AbortError');
	assert.ok(error instanceof DOMException);
});

test('aborts even if milliseconds are set to infinity', async () => {
	const abortController = new AbortController();

	abortController.abort();

	const promise = pTimeout(delay(3000), {
		milliseconds: Infinity,
		signal: abortController.signal,
	});

	const error = await captureRejection(promise);
	assert.strictEqual(error?.name, 'AbortError');
	assert.ok(error instanceof DOMException);
});

const testAbortListenerCleanup = async promiseFactory => {
	const abortController = new AbortController();
	const {signal} = abortController;

	const addEventListenerSpy = sinon.spy(signal, 'addEventListener');
	const removeEventListenerSpy = sinon.spy(signal, 'removeEventListener');

	const promise = pTimeout(promiseFactory(), {
		milliseconds: 100,
		signal,
	});

	try {
		await promise;
	} catch {
		// Ignore promise rejections
	}

	addEventListenerSpy.restore();
	removeEventListenerSpy.restore();

	return [addEventListenerSpy.calledWith('abort'), removeEventListenerSpy.calledWith('abort')];
};

test('removes abort listener after promise settles', async () => {
	const [wasAdded, wasRemoved] = await testAbortListenerCleanup(() => delay(50));
	assert.ok(wasAdded, 'addEventListener should be called with "abort"');
	assert.ok(wasRemoved, 'removeEventListener should be called with "abort"');
});

test('removes abort listener after promise rejects', async () => {
	const rejectingPromise = async () => {
		await delay(50);
		throw new Error('Test error');
	};

	const [wasAdded, wasRemoved] = await testAbortListenerCleanup(rejectingPromise);
	assert.ok(wasAdded, 'addEventListener should be called with "abort"');
	assert.ok(wasRemoved, 'removeEventListener should be called with "abort"');
});

const createRejectingPromise = async () => {
	await delay(1);
	throw new Error('test error for stack trace');
};

const wrapperFunction = async () => {
	await pTimeout(createRejectingPromise(), {milliseconds: 100});
};

test('preserves stack trace when promise rejects', async () => {
	await assert.rejects(wrapperFunction(), error => {
		assert.strictEqual(error.message, 'test error for stack trace');
		// Stack trace should include the wrapperFunction call
		assert.ok(error.stack?.includes('wrapperFunction'));
		return true;
	});
});

test('already aborted signal observes input rejections', async () => {
	const {stdout} = await promisify(execFile)(process.execPath, [
		'--unhandled-rejections=strict',
		'--input-type=module',
		'--eval',
		`
			import assert from 'node:assert/strict';
			import pTimeout from ${JSON.stringify(new URL('index.js', import.meta.url).href)};
			const reason = new Error('cancelled');
			const signal = AbortSignal.abort(reason);
			for (const milliseconds of [10, Infinity]) {
				await assert.rejects(pTimeout(Promise.reject(new Error('input failed')), {
					milliseconds,
					signal,
				}), error => error === reason);
			}
			await new Promise(resolve => setImmediate(resolve));
			console.log('handled');
		`,
	]);

	assert.strictEqual(stdout.trim(), 'handled');
});

test('an infinite timeout settles even with custom timers', async () => {
	// The early return correctly skips creating a timer, but `clear()` then called `clearTimeout(undefined)`, and a
	// throw from inside `finally` replaced the settled value.
	const customTimers = {
		setTimeout() {
			throw new Error('should never be called');
		},
		clearTimeout(token) {
			if (token === undefined) {
				throw new TypeError('clearTimeout called with undefined');
			}
		},
	};

	const settled = pTimeout(Promise.resolve('done'), {milliseconds: Infinity, customTimers});
	assert.strictEqual(await settled, 'done');

	const rejected = pTimeout(Promise.reject(new Error('inner')), {milliseconds: Infinity, customTimers});
	await assert.rejects(rejected, {message: 'inner'});
});
