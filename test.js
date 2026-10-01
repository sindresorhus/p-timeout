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

const settleOutcome = async promise => {
	try {
		await promise;
		return 'resolved';
	} catch {
		return 'rejected';
	}
};

// Reports how a promise settled, or that it was still pending after `milliseconds`.
const settleWithin = (promise, milliseconds) => Promise.race([
	settleOutcome(promise),
	delay(milliseconds, {value: 'still pending'}),
]);

// A never-settling promise with a `.cancel()` method. `p-cancelable` cannot be used to test a throwing `.cancel()`, since it catches handler errors and rejects itself rather than letting them escape.
const createCancelable = cancel => {
	const promise = new Promise(() => {});
	promise.cancel = cancel;
	return promise;
};

const throwingClearTimers = {
	setTimeout,
	clearTimeout() {
		throw new Error('`clearTimeout` blew up');
	},
};

// Real timers that record every call, so a test can see exactly what p-timeout asked for.
const createRecordingTimers = () => {
	const calls = {setTimeout: [], clearTimeout: []};
	const customTimers = {
		setTimeout(callback, milliseconds) {
			calls.setTimeout.push(milliseconds);
			return setTimeout(callback, milliseconds);
		},
		clearTimeout(timer) {
			calls.clearTimeout.push(timer);
			clearTimeout(timer);
		},
	};

	return {calls, customTimers};
};

// A synchronous thenable, which the declared `PromiseLike` input type allows. It settles during the call to `then`, so anything that relies on the input settling in a microtask is bypassed.
const createSyncThenable = settle => ({
	// eslint-disable-next-line unicorn/no-thenable -- being a thenable is the entire point
	then(onFulfilled, onRejected) {
		settle(onFulfilled, onRejected);
	},
});

// Runs `code` with p-timeout in a child process that crashes on any unhandled rejection. The output is `handled` only when it got to the end.
const runWithStrictUnhandledRejections = async code => {
	const {stdout} = await promisify(execFile)(process.execPath, [
		'--unhandled-rejections=strict',
		'--input-type=module',
		'--eval',
		`
			import assert from 'node:assert/strict';
			import pTimeout from ${JSON.stringify(new URL('index.js', import.meta.url).href)};
			${code}
			await new Promise(resolve => setTimeout(resolve, 100));
			console.log('handled');
		`,
	]);

	return stdout.trim();
};

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

const createRejectingPromise = async () => {
	await delay(1);
	throw new Error('test error for stack trace');
};

const wrapperFunction = async () => {
	await pTimeout(createRejectingPromise(), {milliseconds: 100});
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

test('milliseconds beyond the maximum timer delay never times out', async () => {
	// `setTimeout` cannot represent a delay above 2 ** 31 - 1. It silently clamps to 1ms, so a request for `2 ** 31` milliseconds used to time out immediately.
	const outcomes = await Promise.all([2 ** 31, 2 ** 40, 1e12].map(async milliseconds => settleWithin(
		pTimeout(new Promise(() => {}), {milliseconds}),
		100,
	)));

	assert.deepEqual(outcomes, ['still pending', 'still pending', 'still pending']);
});

test('does not emit a timeout overflow warning', async () => {
	const warnings = [];
	const onWarning = warning => {
		warnings.push(warning);
	};

	process.on('warning', onWarning);
	try {
		await settleWithin(pTimeout(new Promise(() => {}), {milliseconds: 2 ** 31}), 100);
	} finally {
		process.removeListener('warning', onWarning);
	}

	assert.deepEqual(warnings, []);
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

test('a throwing `.cancel()` still times out', async () => {
	// A `.cancel()` that throws used to escape the timer callback as an uncaught exception, which crashed the process and left the promise pending forever.
	const promise = createCancelable(() => {
		throw new Error('`.cancel()` blew up');
	});

	await assert.rejects(pTimeout(promise, {milliseconds: 20}), TimeoutError);
});

test('accepts `customTimers` option', async () => {
	const {calls, customTimers} = createRecordingTimers();

	await pTimeout(delay(50), {milliseconds: 123, customTimers});

	assert.deepEqual(calls.setTimeout, [123]);
	assert.strictEqual(calls.clearTimeout.length, 1, '`clearTimeout` should have been called once the promise settled');
});

test('a timeout at the maximum timer delay still arms a timer', async () => {
	// The boundary of the never-elapses rule: `2 ** 31 - 1` is still a delay `setTimeout` can represent.
	const {calls, customTimers} = createRecordingTimers();

	await pTimeout(Promise.resolve(), {milliseconds: (2 ** 31) - 1, customTimers});
	await pTimeout(Promise.resolve(), {milliseconds: 2 ** 31, customTimers});

	assert.deepEqual(calls.setTimeout, [(2 ** 31) - 1]);
});

test('a throwing `removeEventListener` does not change the outcome', async () => {
	// The same cleanup path, so a misbehaving signal must not be able to corrupt the settled result either.
	const signal = {
		aborted: false,
		addEventListener() {},
		removeEventListener() {
			throw new Error('`removeEventListener` blew up');
		},
	};

	assert.strictEqual(await pTimeout(Promise.resolve(fixture), {milliseconds: 100, signal}), fixture);
	await assert.rejects(
		pTimeout(Promise.reject(fixtureError), {milliseconds: 100, signal}),
		{message: fixtureError.message},
	);
});

test('a throwing `clearTimeout` neither changes the outcome nor skips removing the abort listener', async () => {
	// `clear()` runs from a `finally` callback, so a throw used to replace the already-settled value with the `clearTimeout` error. The other cleanup step still has to run too, or the signal keeps holding the handler, which is the listener leak from issue 42 all over again.
	const controller = new AbortController();
	const removeEventListenerSpy = sinon.spy(controller.signal, 'removeEventListener');
	const options = {milliseconds: 100, signal: controller.signal, customTimers: throwingClearTimers};

	try {
		assert.strictEqual(await pTimeout(Promise.resolve(fixture), options), fixture);
		await assert.rejects(pTimeout(Promise.reject(fixtureError), options), {message: fixtureError.message});
	} finally {
		removeEventListenerSpy.restore();
	}

	assert.strictEqual(removeEventListenerSpy.callCount, 2, 'the abort listener must still be removed');
});

test('a throwing `clearTimeout` propagates from an explicit `clear()`', async () => {
	// A direct call is the caller's own business, so the error surfaces there.
	const promise = pTimeout(new Promise(() => {}), {milliseconds: 30, customTimers: throwingClearTimers});

	assert.throws(() => {
		promise.clear();
	}, {message: '`clearTimeout` blew up'});

	// The timer handle survives the throw, so the timeout still fires and nothing is left dangling.
	await assert.rejects(promise, TimeoutError);
});

test('only builds a `TimeoutError` when the timeout can reject with one', async () => {
	// `Error.captureStackTrace` is expensive and almost every timeout resolves first, so building the error unconditionally was pure overhead. It still has to be built before the timer fires so that its stack points at the caller.
	/* eslint-disable unicorn/no-nonstandard-builtin-properties -- V8-only API, used by p-timeout itself */
	const originalCaptureStackTrace = Error.captureStackTrace;
	let captureCount = 0;
	Error.captureStackTrace = function (...arguments_) {
		captureCount++;
		return originalCaptureStackTrace.apply(this, arguments_);
	};
	/* eslint-enable unicorn/no-nonstandard-builtin-properties */

	let unused;
	let used;
	try {
		// None of these can reject with a `TimeoutError`.
		await pTimeout(Promise.resolve(fixture), {milliseconds: 100, message: false});
		await pTimeout(Promise.resolve(fixture), {milliseconds: 100, message: new RangeError('cake')});
		await pTimeout(Promise.resolve(fixture), {milliseconds: 100, fallback: () => fixture});
		unused = captureCount;

		await assert.rejects(pTimeout(delay(200), {milliseconds: 20}), TimeoutError);
		await assert.rejects(pTimeout(delay(200), {milliseconds: 20, message: 'too slow'}), TimeoutError);
		used = captureCount - unused;
	} finally {
		/* eslint-disable-next-line unicorn/no-nonstandard-builtin-properties -- restoring what we replaced */
		Error.captureStackTrace = originalCaptureStackTrace;
	}

	assert.deepEqual([unused, used], [0, 2]);
});

test('throws when `customTimers` is missing a function', async () => {
	// A half-configured `customTimers` used to fail much later with a cryptic "Cannot read properties of undefined (reading 'call')".
	const incomplete = [{setTimeout}, {clearTimeout}, {}];
	const errors = await Promise.all(incomplete.map(async customTimers => captureRejection(
		pTimeout(delay(50), {milliseconds: 100, customTimers}),
	)));

	const [first] = errors;
	assert.deepEqual(errors, [first, first, first], 'every incomplete `customTimers` should fail the same way');
	assert.ok(first instanceof TypeError);
	assert.strictEqual(
		first.message,
		'Expected `customTimers` to have a `setTimeout` and a `clearTimeout` function',
	);
});

test('`.clear()` method', async () => {
	const end = timeSpan();
	const promise = pTimeout(delay(300), {milliseconds: 200});

	promise.clear();

	// The bound is generous on purpose. What this asserts is that the promise resolved from the input at all, which it cannot do if the 200ms timeout fired. The 300ms input only has to be slower than 200ms, and a loaded machine can easily take twice that, so a tight upper bound would only add flakiness.
	await promise;
	assert.ok(inRange(end(), {start: 0, end: 1000}));
});

test('`.clear()` method can be called multiple times', async () => {
	const promise = pTimeout(delay(50, {value: fixture}), {milliseconds: 200});

	promise.clear();
	promise.clear(); // Should not throw

	assert.strictEqual(await promise, fixture);
});

test('`.clear()` only clears the timeout, not the signal', async () => {
	const controller = new AbortController();
	const promise = pTimeout(new Promise(() => {}), {milliseconds: 20, signal: controller.signal});

	promise.clear();
	await delay(50);

	const reason = new Error('aborted after clearing');
	controller.abort(reason);
	assert.strictEqual(await captureRejection(promise), reason);
});

test('calls `.cancel()` on the input when a fallback is used', async t => {
	// A fallback still means the input timed out, and the readme promises `.cancel()` is called then, but the fallback branch returned before reaching it, so the input kept running.
	const cancel = t.mock.fn();

	const result = await pTimeout(createCancelable(cancel), {milliseconds: 20, fallback: () => 'fallback result'});

	assert.strictEqual(result, 'fallback result');
	assert.strictEqual(cancel.mock.callCount(), 1, '`.cancel()` should have been called on the input');
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

test('rejects with the exact abort reason', async () => {
	// `AbortController#abort(null)` sets `signal.reason` to `null`, and that is the reason callers observe. It used to be swapped for a DOMException, hiding the value the caller deliberately passed.
	const reasons = [null, 'a string', 0, false, {code: 'fixture'}];
	const captured = await Promise.all(reasons.map(async reason => captureRejection(pTimeout(new Promise(() => {}), {
		milliseconds: 100,
		signal: AbortSignal.abort(reason),
	}))));

	assert.deepEqual(captured, reasons);
});

test('a signal without a `reason` property rejects with an `AbortError`', async () => {
	// Only a hand-rolled signal object can lack the property, and it still has to reject with something meaningful.
	const error = await captureRejection(pTimeout(new Promise(() => {}), {milliseconds: 100, signal: {aborted: true}}));

	assert.ok(error instanceof DOMException);
	assert.strictEqual(error.name, 'AbortError');
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

test('calls `.cancel()` on the input when the signal aborts', async t => {
	// A timeout cancels the input, so an abort must too. Otherwise the work keeps running after the caller has said it no longer wants the result.
	const cancel = t.mock.fn();

	const controller = new AbortController();
	const wrapped = pTimeout(createCancelable(cancel), {milliseconds: 5000, signal: controller.signal});
	controller.abort();

	await assert.rejects(wrapped, {name: 'AbortError'});
	assert.strictEqual(cancel.mock.callCount(), 1, '`.cancel()` should have been called on the input');
});

test('calls `.cancel()` on the input for an already aborted signal', async t => {
	const cancel = t.mock.fn();

	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		pTimeout(createCancelable(cancel), {milliseconds: 5000, signal: controller.signal}),
		{name: 'AbortError'},
	);
	assert.strictEqual(cancel.mock.callCount(), 1, '`.cancel()` should have been called on the input');
});

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

test('preserves stack trace when promise rejects', async () => {
	await assert.rejects(wrapperFunction(), error => {
		assert.strictEqual(error.message, 'test error for stack trace');
		// Stack trace should include the wrapperFunction call
		assert.ok(error.stack?.includes('wrapperFunction'));
		return true;
	});
});

test('already aborted signal observes input rejections', async () => {
	assert.strictEqual(await runWithStrictUnhandledRejections(`
		const reason = new Error('cancelled');
		const signal = AbortSignal.abort(reason);
		for (const milliseconds of [10, Infinity]) {
			await assert.rejects(pTimeout(Promise.reject(new Error('input failed')), {
				milliseconds,
				signal,
			}), error => error === reason);
		}
	`), 'handled');
});

test('an infinite timeout settles even with custom timers', async () => {
	// The early return correctly skips creating a timer, but `clear()` then called `clearTimeout(undefined)`, and a throw from inside `finally` replaced the settled value.
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
	settled.clear();
	assert.strictEqual(await settled, 'done');

	const rejected = pTimeout(Promise.reject(new Error('inner')), {milliseconds: Infinity, customTimers});
	await assert.rejects(rejected, {message: 'inner'});
});

// Edge cases
test('throws when milliseconds is zero, `-Infinity`, or a boxed number', async () => {
	// `0` is out of contract: the option is documented as a positive number.
	// eslint-disable-next-line no-new-wrappers, unicorn/new-for-builtins -- a boxed number is the point
	const errors = await Promise.all([0, -Infinity, new Number(50)].map(async milliseconds => captureRejection(pTimeout(delay(50), {milliseconds}))));

	assert.ok(errors.every(error => error instanceof TypeError));
});

test('accepts fractional milliseconds', async () => {
	await assert.rejects(pTimeout(delay(200), {milliseconds: 0.5}), TimeoutError);
});

test('the default timeout message names the milliseconds', async () => {
	const error = await captureRejection(pTimeout(delay(200), {milliseconds: 50}));

	assert.strictEqual(error?.name, 'TimeoutError');
	assert.ok(error instanceof TimeoutError);
	assert.strictEqual(error?.message, 'Promise timed out after 50 milliseconds');
});

test('accepts an empty string message', async () => {
	const error = await captureRejection(pTimeout(delay(200), {milliseconds: 50, message: ''}));

	assert.ok(error instanceof TimeoutError);
	assert.strictEqual(error?.message, '');
});

test('rejects with the exact error instance passed as `message`', async () => {
	const customError = new TypeError('too slow');
	const promise = pTimeout(delay(200), {milliseconds: 50, message: customError});

	assert.strictEqual(await captureRejection(promise), customError);
});

test('supports a `TimeoutError` subclass as `message`', async () => {
	// The readme recommends sub-classing `TimeoutError` for custom errors.
	class MyCustomError extends TimeoutError {
		name = 'MyCustomError';
	}

	const error = await captureRejection(pTimeout(delay(200), {
		milliseconds: 50,
		message: new MyCustomError('it’s over 9000'),
	}));

	assert.strictEqual(error?.name, 'MyCustomError');
	assert.ok(error instanceof MyCustomError);
	assert.ok(error instanceof TimeoutError);
});

test('a `TimeoutError` stack points at the caller', async () => {
	// The error is built before the timer is armed specifically so its stack names this call site and not the timer callback. Skipping that build when the error cannot be used must not change it when it can.
	const timeoutFromCaller = async () => pTimeout(delay(200), {milliseconds: 20});

	const error = await captureRejection(timeoutFromCaller());
	const {stack} = error;
	assert.ok(stack?.includes('timeoutFromCaller'), `stack was: ${stack}`);
});

test('the timer is cleared exactly once, and `.clear()` after settling is a no-op', async () => {
	const {calls, customTimers} = createRecordingTimers();

	const resolved = pTimeout(delay(20, {value: fixture}), {milliseconds: 5000, customTimers});
	assert.strictEqual(await resolved, fixture);
	await assert.rejects(pTimeout(Promise.reject(fixtureError), {milliseconds: 5000, customTimers}), {message: fixtureError.message});
	assert.strictEqual(calls.clearTimeout.length, 2, 'each timer is cleared once, on settle');

	resolved.clear();
	assert.strictEqual(calls.clearTimeout.length, 2, 'a later `clear()` has no timer left to clear');
});

test('a `setTimeout` that fires synchronously settles and still clears the timer', async () => {
	// A timer that calls back before handing back a handle still has to settle the promise, and cleanup has to cope with `timer` not having been assigned at the moment the callback ran.
	const cleared = [];
	const customTimers = {
		setTimeout(callback) {
			callback();
			return 1;
		},
		clearTimeout(timer) {
			cleared.push(timer);
		},
	};

	// The callback runs before the input's own reaction can run, so the timeout wins.
	await assert.rejects(
		pTimeout(Promise.resolve(fixture), {milliseconds: 50, customTimers}),
		{message: 'Promise timed out after 50 milliseconds'},
	);

	assert.deepEqual(cleared, [1], 'the handle returned after the callback must still be cleared');
});

test('a `setTimeout` that throws rejects with its error', async () => {
	const customTimers = {
		setTimeout() {
			throw new Error('timer unavailable');
		},
		clearTimeout,
	};

	await assert.rejects(
		pTimeout(delay(200), {milliseconds: 50, customTimers}),
		{message: 'timer unavailable'},
	);
});

test('the readme retry example works', async () => {
	const delayedPromise = async () => {
		await delay(20);
		return fixture;
	};

	const result = await pTimeout(delayedPromise(), {
		milliseconds: 5,
		fallback: () => pTimeout(delayedPromise(), {milliseconds: 500}),
	});

	assert.strictEqual(result, fixture);
});

test('aborting after the promise settled does not cancel the input', async () => {
	// The listener is detached on settle, so a later abort reaches nothing. If it did not, the abort handler would cancel an input the caller has already been given the result of.
	let didCancel = false;
	const input = delay(20, {value: fixture});
	input.cancel = () => {
		didCancel = true;
	};

	const controller = new AbortController();
	const promise = pTimeout(input, {milliseconds: 5000, signal: controller.signal});

	assert.strictEqual(await promise, fixture);

	controller.abort();
	await delay(20);

	assert.ok(!didCancel, 'a settled promise must not cancel its input on a later abort');
});

test('an abort rejects even when `message` is `false`', async () => {
	// `message: false` only covers timeouts. An abort is a cancellation, so it still rejects with the reason.
	const controller = new AbortController();
	const promise = pTimeout(new Promise(() => {}), {
		milliseconds: 5000,
		message: false,
		signal: controller.signal,
	});

	controller.abort();
	await assert.rejects(promise, {name: 'AbortError'});
});

test('a timeout detaches the abort listener', async () => {
	// The upstream listener tests only cover the input settling. Once the timeout wins, a later abort has to reach nothing.
	const controller = new AbortController();
	const removeEventListenerSpy = sinon.spy(controller.signal, 'removeEventListener');

	try {
		await assert.rejects(pTimeout(new Promise(() => {}), {milliseconds: 20, signal: controller.signal}), TimeoutError);
	} finally {
		removeEventListenerSpy.restore();
	}

	assert.ok(removeEventListenerSpy.calledWith('abort'));
});

test('works with an `AbortSignal.timeout()`', async () => {
	await assert.rejects(
		pTimeout(new Promise(() => {}), {milliseconds: 5000, signal: AbortSignal.timeout(20)}),
		{name: 'TimeoutError'},
	);
});

test('works with `AbortSignal.any()`', async () => {
	const controller = new AbortController();
	const promise = pTimeout(new Promise(() => {}), {
		milliseconds: 5000,
		signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
	});

	controller.abort(new Error('cancelled through any()'));

	const error = await captureRejection(promise);
	assert.strictEqual(error?.message, 'cancelled through any()');
});

test('cancelling the input does not produce an unhandled rejection', async () => {
	// Both abort paths now call `.cancel()`, which can reject the input. That rejection still has to be observed.
	assert.strictEqual(await runWithStrictUnhandledRejections(`
		// An input that rejects as a side effect of being cancelled.
		const createInput = cancel => {
			let rejectInput;
			const promise = new Promise((resolve, reject) => {
				rejectInput = reject;
			});
			promise.cancel = () => {
				cancel();
				rejectInput(new Error('input failed while cancelling'));
			};
			return promise;
		};

		// Already aborted, so the input is cancelled before anything is awaited.
		await assert.rejects(
			pTimeout(createInput(() => {}), {milliseconds: 10, signal: AbortSignal.abort(new Error('cancelled'))}),
			{message: 'cancelled'},
		);

		// Aborted mid-flight, with a \`.cancel()\` that throws before the input is rejected.
		const controller = new AbortController();
		const wrapped = pTimeout(createInput(() => {
			throw new Error('cancel blew up');
		}), {milliseconds: 1000, signal: controller.signal});
		controller.abort();
		await assert.rejects(wrapped, {name: 'AbortError'});

		// Timed out, after which the input rejects well after the wrapper has settled.
		const late = new Promise((resolve, reject) => {
			setTimeout(() => reject(new Error('late input failure')), 50);
		});
		await assert.rejects(pTimeout(late, {milliseconds: 10}), {name: 'TimeoutError'});
	`), 'handled');
});

test('custom timers are called without a receiver', async () => {
	// In a browser, `setTimeout` called as a method of another object throws "Illegal invocation", so p-timeout has to invoke the custom timers with no receiver at all. Regression test for issue 45.
	const receivers = {};

	const customTimers = {
		setTimeout(...arguments_) {
			receivers.setTimeout = this;
			return setTimeout(...arguments_);
		},
		clearTimeout(...arguments_) {
			receivers.clearTimeout = this;
			return clearTimeout(...arguments_);
		},
	};

	await pTimeout(Promise.resolve(fixture), {milliseconds: 5000, customTimers});

	assert.deepEqual(receivers, {setTimeout: undefined, clearTimeout: undefined});
});

test('the default timers follow the global ones', async () => {
	// The default is resolved per call rather than captured at import, so fake timers installed after p-timeout is imported are still honoured. Hoisting it to a module constant would silently break every suite that installs fake timers, which is exactly what the readme's `customTimers` escape hatch exists for.
	/* eslint-disable unicorn/no-global-object-property-assignment -- patching the global is the whole point */
	const originalSetTimeout = setTimeout;
	const requested = [];

	let promise;
	try {
		globalThis.setTimeout = (callback, milliseconds) => {
			requested.push(milliseconds);
			return originalSetTimeout(callback, milliseconds);
		};

		promise = pTimeout(Promise.resolve(fixture), {milliseconds: 4242});
	} finally {
		// Restored before awaiting, so nothing else in the process ever runs against the patched global.
		globalThis.setTimeout = originalSetTimeout;
	}
	/* eslint-enable unicorn/no-global-object-property-assignment */

	await promise;
	assert.deepEqual(requested, [4242]);
});

test('invalid options still observe the input rejection', async () => {
	// An invalid option rejects the wrapped promise, but the caller's input still needs a rejection handler. Without one, the input's failure escapes as an unhandled rejection and takes the whole process down, hiding the `TypeError` that actually explains the mistake.
	assert.strictEqual(await runWithStrictUnhandledRejections(`
		const invalidOptions = [
			{milliseconds: 'x'},
			{milliseconds: -1},
			{milliseconds: 100, customTimers: {setTimeout}},
			{milliseconds: 100, customTimers: {}},
		];

		for (const options of invalidOptions) {
			await assert.rejects(pTimeout(Promise.reject(new Error('input failed')), options), TypeError);
		}
	`), 'handled');
});

test('invalid options are still rejected for a synchronous thenable', async () => {
	// The option checks have to run before the input is allowed to settle the wrapper. Otherwise a typo in `milliseconds` resolves with the input value and no timeout is ever armed.
	const invalidOptions = [
		{milliseconds: 'nope'},
		{milliseconds: 0},
		{milliseconds: NaN},
		{milliseconds: 50, customTimers: {}},
		{milliseconds: 50, customTimers: {setTimeout}},
	];

	const errors = await Promise.all(invalidOptions.map(async options => captureRejection(
		pTimeout(createSyncThenable(resolve => resolve(fixture)), options),
	)));

	assert.ok(
		errors.every(error => error instanceof TypeError),
		`expected every invalid option to reject with a TypeError, got: ${errors.map(error => error?.constructor.name).join(', ')}`,
	);
});

test('no timer is armed when the outcome is decided up front', async () => {
	// An invalid option wins over an already aborted signal, and neither leaves a timer or listener behind for a promise that has already settled.
	const {calls, customTimers} = createRecordingTimers();
	const signal = AbortSignal.abort();

	await assert.rejects(pTimeout(Promise.resolve(), {milliseconds: 'nope', signal, customTimers}), TypeError);
	await assert.rejects(pTimeout(Promise.resolve(), {milliseconds: 100, signal, customTimers}), {name: 'AbortError'});

	assert.deepEqual(calls, {setTimeout: [], clearTimeout: []});
});

test('an already aborted signal still rejects for a synchronous thenable', async () => {
	// The input settling first must not win over an abort the caller has already committed to.
	const controller = new AbortController();
	controller.abort(new Error('cancelled by caller'));

	const error = await captureRejection(pTimeout(createSyncThenable(resolve => resolve(fixture)), {
		milliseconds: 5000,
		signal: controller.signal,
	}));

	assert.strictEqual(error?.message, 'cancelled by caller');
});

test('attaches exactly one handler to the input', async () => {
	// A second handler on the input costs its rejection the caller frames in the stack trace, so the count matters even though an extra attach looks completely harmless.
	const countAttaches = () => {
		const state = {count: 0};
		const inner = delay(5, {value: fixture});
		state.input = {
			// eslint-disable-next-line unicorn/no-thenable -- a counting thenable is the point
			then(onFulfilled, onRejected) {
				state.count++;
				// eslint-disable-next-line unicorn/prefer-then-catch -- must forward both outcomes verbatim
				return inner.then(onFulfilled, onRejected);
			},
		};
		return state;
	};

	const normal = countAttaches();
	assert.strictEqual(await pTimeout(normal.input, {milliseconds: 500}), fixture);
	assert.strictEqual(normal.count, 1);

	const controller = new AbortController();
	controller.abort();
	const preAborted = countAttaches();
	await assert.rejects(pTimeout(preAborted.input, {milliseconds: 500, signal: controller.signal}), {name: 'AbortError'});
	assert.strictEqual(preAborted.count, 1, 'the pre-aborted path observes the input exactly once too');

	const invalid = countAttaches();
	await assert.rejects(pTimeout(invalid.input, {milliseconds: 'nope'}), TypeError);
	assert.strictEqual(invalid.count, 1, 'the invalid-options path observes the input exactly once too');
});

test('a `.cancel()` that settles the input synchronously cannot change the outcome', async () => {
	// `.cancel()` is free to settle the input on the spot, through the very handlers p-timeout passed to `then`, so the outcome has to be decided before the input is cancelled.
	const createInput = () => {
		let rejectInput;
		return {
			// eslint-disable-next-line unicorn/no-thenable -- being a thenable is the entire point
			then(onFulfilled, onRejected) {
				rejectInput = onRejected;
			},
			cancel() {
				rejectInput?.(new Error('cancelled'));
			},
		};
	};

	await assert.rejects(pTimeout(createInput(), {milliseconds: 20}), TimeoutError);
	assert.strictEqual(await pTimeout(createInput(), {milliseconds: 20, fallback: () => fixture}), fixture);
	assert.strictEqual(await pTimeout(createInput(), {milliseconds: 20, message: false}), undefined);

	const reason = new Error('aborted by caller');
	const controller = new AbortController();
	const aborted = pTimeout(createInput(), {milliseconds: 5000, signal: controller.signal});
	controller.abort(reason);
	assert.strictEqual(await captureRejection(aborted), reason);
});
