export class TimeoutError extends Error {
	name = 'TimeoutError';

	constructor(message, options) {
		super(message, options);
		// V8-only, and it does exactly one thing here: it hides this constructor frame from the stack.
		// eslint-disable-next-line unicorn/no-useless-error-capture-stack-trace, unicorn/no-nonstandard-builtin-properties
		Error.captureStackTrace?.(this, TimeoutError);
	}
}

const getAbortedReason = signal => signal.reason ?? new DOMException('This operation was aborted.', 'AbortError');

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

	const wrappedPromise = new Promise((resolve, reject) => {
		if (typeof milliseconds !== 'number' || Math.sign(milliseconds) !== 1) {
			throw new TypeError(`Expected \`milliseconds\` to be a positive number, got \`${milliseconds}\``);
		}

		if (signal?.aborted) {
			reject(getAbortedReason(signal));
			// The input still needs a rejection handler even though cancellation won.
			// eslint-disable-next-line unicorn/prefer-then-catch
			promise.then(resolve, reject);
			return;
		}

		if (signal) {
			abortHandler = () => {
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
			if (fallback) {
				try {
					resolve(fallback());
				} catch (error) {
					reject(error);
				}

				return;
			}

			if (typeof promise.cancel === 'function') {
				promise.cancel();
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
		cancelablePromise.clear();
		if (abortHandler && signal) {
			signal.removeEventListener('abort', abortHandler);
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
