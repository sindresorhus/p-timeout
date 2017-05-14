'use strict';

class TimeoutError extends Error {
	constructor(message) {
		super(message);
		this.name = 'TimeoutError';
	}
}

module.exports = (promise, ms, fallback) => new Promise((resolve, reject) => {
	if (typeof ms !== 'number') {
		throw new TypeError('Expected `ms` to be a number');
	}

	const timer = setTimeout(() => {
		if (typeof fallback === 'function') {
			resolve(fallback());
			return;
		}

		const message = typeof fallback === 'string' ? fallback : `Promise timed out after ${ms} milliseconds`;
		const err = fallback instanceof Error ? fallback : new TimeoutError(message);

		reject(err);
	}, ms);

	promise.then(
		val => {
			clearTimeout(timer);
			resolve(val);
		},
		err => {
			clearTimeout(timer);
			reject(err);
		}
	);
});

module.exports.TimeoutError = TimeoutError;
