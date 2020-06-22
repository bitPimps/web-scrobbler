import Vue from 'vue';

import { L } from '@/common/i18n';

/**
 * Create a new instance of a Vue model.
 *
 * @param {Object} component Vue component instance
 */
export function createApp(component) {
	Vue.prototype.L = L;

	new Vue({
		mixins: [i18nMixin],
		render: (h) => h(component),
	}).$mount('#content');
}

const i18nMixin = {
	methods: { L },
};
