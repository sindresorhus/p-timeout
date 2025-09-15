import test from 'ava';
import delay from 'delay';
import PCancelable from 'p-cancelable';
import inRange from 'in-range';
import timeSpan from 'time-span';
import sinon from 'sinon';
import pTimeout, {TimeoutError} from './index.js';

const fixture = Symbol('fixture');
const fixtureError = new Error('fixture');

test('resolves before timeout', async t => {
	t.is(await pTimeout(delay(50).then(() => fixture), {milliseconds: 200}), fixture);
});

test('throws when milliseconds is not number', async t => {
	await t.throwsAsync(pTimeout(delay(50), {milliseconds: '200'}), {instanceOf: TypeError});
});

test('throws when milliseconds is negative number', async t => {
	await t.throwsAsync(pTimeout(delay(50), {milliseconds: -1}), {instanceOf: TypeError});
});

test('throws when milliseconds is NaN', async t => {
	await t.throwsAsync(pTimeout(delay(50), {milliseconds: Number.NaN}), {instanceOf: TypeError});
});

test('handles milliseconds being `Infinity`', async t => {
	t.is(
		await pTimeout(delay(50, {value: fixture}), {milliseconds: Number.POSITIVE_INFINITY}),
		fixture,
	);
});

test('rejects after timeout', async t => {
	await t.throwsAsync(pTimeout(delay(200), {milliseconds: 50}), {instanceOf: TimeoutError});
});

test('resolves after timeout with message:false', async t => {
	t.is(
		await pTimeout(delay(200), {milliseconds: 50, message: false}),
		undefined,
	);
});

test('rejects before timeout if specified promise rejects', async t => {
	await t.throwsAsync(pTimeout(delay(50).then(() => {
		throw fixtureError;
	}), {milliseconds: 200}), {message: fixtureError.message});
});

test('fallback argument', async t => {
	await t.throwsAsync(pTimeout(delay(200), {milliseconds: 50, message: 'rainbow'}), {message: 'rainbow'});
	await t.throwsAsync(pTimeout(delay(200), {milliseconds: 50, message: new RangeError('cake')}), {instanceOf: RangeError});
	await t.throwsAsync(pTimeout(delay(200), {milliseconds: 50, fallback: () => Promise.reject(fixtureError)}), {message: fixtureError.message});
	await t.throwsAsync(pTimeout(delay(200), {milliseconds: 50, fallback() {
		throw new RangeError('cake');
	}}), {instanceOf: RangeError});
});

test('calls `.cancel()` on promise when it exists', async t => {
	const promise = new PCancelable(async (resolve, reject, onCancel) => {
		onCancel(() => {
			t.pass();
		});

		await delay(200);
		resolve();
	});

	await t.throwsAsync(pTimeout(promise, {milliseconds: 50}), {instanceOf: TimeoutError});
	t.true(promise.isCanceled);
});

test('accepts `customTimers` option', async t => {
	t.plan(2);

	await pTimeout(delay(50), {
		milliseconds: 123,
		customTimers: {
			setTimeout(fn, milliseconds) {
				t.is(milliseconds, 123);
				return setTimeout(fn, milliseconds);
			},
			clearTimeout(timeoutId) {
				t.pass();
				return clearTimeout(timeoutId);
			},
		},
	});
});

test('`.clear()` method', async t => {
	const end = timeSpan();
	const promise = pTimeout(delay(300), {milliseconds: 200});

	promise.clear();

	await promise;
	t.true(inRange(end(), {start: 0, end: 350}));
});

/**
TODO: Remove if statement when targeting Node.js 16.
*/
if (globalThis.AbortController !== undefined) {
	test('rejects when calling `AbortController#abort()`', async t => {
		const abortController = new AbortController();

		const promise = pTimeout(delay(3000), {
			milliseconds: 2000,
			signal: abortController.signal,
		});

		abortController.abort();

		await t.throwsAsync(promise, {
			name: 'AbortError',
		});
	});

	test('already aborted signal', async t => {
		const abortController = new AbortController();

		abortController.abort();

		await t.throwsAsync(pTimeout(delay(3000), {
			milliseconds: 2000,
			signal: abortController.signal,
		}), {
			name: 'AbortError',
		});
	});

	test('aborts even if milliseconds are set to infinity', async t => {
		const abortController = new AbortController();

		abortController.abort();

		await t.throwsAsync(pTimeout(delay(3000), {
			milliseconds: Number.POSITIVE_INFINITY,
			signal: abortController.signal,
		}), {
			name: 'AbortError',
		});
	});

	test('removes abort listener after promise settles', async t => {
		const abortController = new AbortController();
		const {signal} = abortController;

		const addEventListenerSpy = sinon.spy(signal, 'addEventListener');
		const removeEventListenerSpy = sinon.spy(signal, 'removeEventListener');

		const promise = pTimeout(delay(50), {
			milliseconds: 100,
			signal,
		});

		await promise;

		t.true(addEventListenerSpy.calledWith('abort'), 'addEventListener should be called with "abort"');
		t.true(removeEventListenerSpy.calledWith('abort'), 'removeEventListener should be called with "abort"');

		addEventListenerSpy.restore();
		removeEventListenerSpy.restore();
	});

	test('removes abort listener after promise rejects', async t => {
		const abortController = new AbortController();
		const {signal} = abortController;

		const addEventListenerSpy = sinon.spy(signal, 'addEventListener');
		const removeEventListenerSpy = sinon.spy(signal, 'removeEventListener');

		const promise = pTimeout(
			(async () => {
				await delay(50);
				throw new Error('Test error');
			})(),
			{
				milliseconds: 100,
				signal,
			},
		);

		await t.throwsAsync(promise, {message: 'Test error'});

		t.true(addEventListenerSpy.calledWith('abort'), 'addEventListener should be called with "abort"');
		t.true(removeEventListenerSpy.calledWith('abort'), 'removeEventListener should be called with "abort"');

		addEventListenerSpy.restore();
		removeEventListenerSpy.restore();
	});
}

const createRejectingPromise = async () => {
	await delay(1);
	throw new Error('test error for stack trace');
};

const wrapperFunction = async () => {
	await pTimeout(createRejectingPromise(), {milliseconds: 100});
};

test('preserves stack trace when promise rejects', async t => {
	try {
		await wrapperFunction();
		t.fail('Should have thrown');
	} catch (error) {
		t.is(error.message, 'test error for stack trace');
		// Stack trace should include the wrapperFunction call
		t.true(error.stack.includes('wrapperFunction'));
	}
});
