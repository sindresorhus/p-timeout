import {expectType, expectError} from 'tsd';
import pTimeout = require('.');
import {TimeoutError} from '.';

const delayedPromise: () => Promise<string> = async () => {
	return new Promise(resolve => {
		setTimeout(() => {
			resolve('foo');
		}, 200);
	});
};

pTimeout(delayedPromise(), 50).then(() => 'foo');
pTimeout(delayedPromise(), 50, () => {
	return pTimeout(delayedPromise(), 300);
});
pTimeout(delayedPromise(), 50).then(value => expectType<string>(value));
pTimeout(delayedPromise(), 50, 'error').then(value =>
	expectType<string>(value)
);
pTimeout(delayedPromise(), 50, new Error('error')).then(value =>
	expectType<string>(value)
);
pTimeout(delayedPromise(), 50, async () => 10).then(value => {
	expectType<string | number>(value);
});
pTimeout(delayedPromise(), 50, () => 10).then(value => {
	expectType<string | number>(value);
});

const customTimers = {setTimeout, clearTimeout};
pTimeout(delayedPromise(), 50, undefined, {customTimers});
pTimeout(delayedPromise(), 50, 'foo', {customTimers});
pTimeout(delayedPromise(), 50, new Error('error'), {customTimers});
pTimeout(delayedPromise(), 50, () => 10, {});

expectError(pTimeout(delayedPromise(), 50, () => 10, {customTimers: {setTimeout}}));
expectError(pTimeout(delayedPromise(), 50, () => 10, {
	customTimers: {
		setTimeout: () => 42, // Invalid `setTimeout` implementation
		clearTimeout
	}
}));

const timeoutError = new TimeoutError();
expectType<TimeoutError>(timeoutError);
