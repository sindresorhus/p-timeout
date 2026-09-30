export class TimeoutError extends Error {
	name = 'TimeoutError';

	constructor(message, options) {
		super(message, options);
		// V8-only, and it does exactly one thing here: it hides this constructor frame from the stack.
		// eslint-disable-next-line unicorn/no-useless-error-capture-stack-trace, unicorn/no-nonstandard-builtin-properties
		Error.captureStackTrace?.(this, TimeoutError);
	}
}

// An `AbortSignal` always has a reason once aborted, and that reason is whatever the caller passed to
// `abort()`, including `null`. Only hand-rolled signal objects can lack the property entirely.
const getAbortedReason = signal => 'reason' in signal
	? signal.reason
	: new DOMException('This operation was aborted.', 'AbortError');

// `setTimeout` stores its delay in a 32-bit signed integer, so this is the largest delay it can represent.
const maximumDelay = (2 ** 31) - 1;

export default function pTimeout(promise, options) {
	const {
		milliseconds,
		fallback,
		message,
		customTimers = {setTimeout, clearTimeout},
		signal,
	} = options;

	let timer;
	let abortHandler;

	// Best-effort cancellation of the input. A throwing `.cancel()` must never prevent us from settling, and
	// must never escape the timer callback as an uncaught exception. Anything that is not callable is simply
	// skipped, so the `try` covers that case too.
	const cancelInput = () => {
		try {
			promise.cancel?.();
		} catch {
			// Ignored: the timeout outcome matters more than a failure to stop the work early.
		}
	};

	const wrappedPromise = new Promise((resolve, reject) => {
		if (typeof milliseconds !== 'number' || Math.sign(milliseconds) !== 1) {
			throw new TypeError(`Expected \`milliseconds\` to be a positive number, got \`${milliseconds}\``);
		}

		if (signal?.aborted) {
			// The caller gave up before we even started, so the input has nothing worth waiting for.
			cancelInput();
			reject(getAbortedReason(signal));
			// The input still needs a rejection handler even though cancellation won.
			// eslint-disable-next-line unicorn/prefer-then-catch
			promise.then(resolve, reject);
			return;
		}

		if (signal) {
			abortHandler = () => {
				// Same as a timeout: the caller no longer wants the result, so stop the underlying work.
				cancelInput();
				reject(getAbortedReason(signal));
			};

			signal.addEventListener('abort', abortHandler, {once: true});
		}

		// Use .then() instead of async IIFE to preserve stack traces
		// eslint-disable-next-line unicorn/prefer-then-catch
		promise.then(resolve, reject);

		// A delay that `setTimeout` cannot represent never elapses, so there is nothing to time out. Without
		// this, `setTimeout` silently clamps anything above 2 ** 31 - 1 to 1ms and the timeout fires at once.
		if (milliseconds > maximumDelay) {
			return;
		}

		// We create the error outside of `setTimeout` to preserve the stack trace.
		const timeoutError = new TimeoutError();

		// `.call(undefined, ...)` is needed for custom timers to avoid context issues
		timer = customTimers.setTimeout.call(undefined, () => {
			// The input has timed out either way, so the underlying work is stopped even when a fallback takes
			// over. The readme promises `.cancel()` runs on timeout.
			cancelInput();

			if (fallback) {
				try {
					resolve(fallback());
				} catch (error) {
					reject(error);
				}

				return;
			}

			if (message === false) {
				resolve();
			} else if (message instanceof Error) {
				reject(message);
			} else {
				timeoutError.message = message ?? `Promise timed out after ${milliseconds} milliseconds`;
				reject(timeoutError);
			}
		}, milliseconds);
	});

	const cancelablePromise = wrappedPromise.finally(() => {
		// This cleanup runs after the promise has already settled, so neither step may change the outcome, and
		// neither may stop the other: a `clearTimeout` that throws must not leave the abort listener attached.
		try {
			cancelablePromise.clear();
		} catch {
			// Ignored: the result has already been decided, and a failed cleanup cannot un-decide it. The timer
			// handle is deliberately left in place so an explicit `clear()` can still retry.
		}

		try {
			if (abortHandler) {
				signal.removeEventListener('abort', abortHandler);
			}
		} catch {
			// Ignored, for the same reason.
		}
	});

	cancelablePromise.clear = () => {
		// A timeout that never elapses creates no timer, and a custom `clearTimeout` is entitled to reject `undefined`.
		if (timer === undefined) {
			return;
		}

		// `.call(undefined, ...)` is needed for custom timers to avoid context issues
		customTimers.clearTimeout.call(undefined, timer);
		timer = undefined;
	};

	return cancelablePromise;
}
