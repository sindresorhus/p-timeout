/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable unicorn/prefer-top-level-await */
import {expectType, expectError} from 'tsd';
import pTimeout, {TimeoutError} from './index.js';

const delayedPromise: () => Promise<string> = async () => new Promise(resolve => {
	setTimeout(() => {
		resolve('foo');
	}, 200);
});

pTimeout(delayedPromise(), {milliseconds: 50}).then(() => 'foo');
pTimeout(delayedPromise(), {milliseconds: 50, fallback: async () => pTimeout(delayedPromise(), {milliseconds: 300})});
pTimeout(delayedPromise(), {milliseconds: 50}).then(value => {
	expectType<string>(value);
});
pTimeout(delayedPromise(), {milliseconds: 50, message: 'error'}).then(value => {
	expectType<string>(value);
});
pTimeout(delayedPromise(), {milliseconds: 50, message: false}).then(value => {
	expectType<string | undefined>(value);
});
pTimeout(delayedPromise(), {milliseconds: 50, message: new Error('error')}).then(value => {
	expectType<string>(value);
});
pTimeout(delayedPromise(), {milliseconds: 50, fallback: async () => 10}).then(value => {
	expectType<string | number>(value);
});
pTimeout(delayedPromise(), {milliseconds: 50, fallback: () => 10}).then(value => {
	expectType<string | number>(value);
});

const customTimers = {setTimeout, clearTimeout};
pTimeout(delayedPromise(), {milliseconds: 50, customTimers});
pTimeout(delayedPromise(), {milliseconds: 50, message: 'foo', customTimers});
pTimeout(delayedPromise(), {milliseconds: 50, message: new Error('error'), customTimers});
pTimeout(delayedPromise(), {milliseconds: 50, fallback: () => 10});

expectError(pTimeout(delayedPromise(), {
	milliseconds: 50,
	fallback: () => 10,
	customTimers: {
		setTimeout,
	},
}));

expectError(pTimeout(delayedPromise(), {
	milliseconds: 50,
	fallback: () => 10,
	customTimers: {
		setTimeout: () => 42, // Invalid `setTimeout` implementation
		clearTimeout,
	},
}));

expectError(pTimeout(delayedPromise(), {})); // `milliseconds` is required

const timeoutError = new TimeoutError();
expectType<TimeoutError>(timeoutError);
