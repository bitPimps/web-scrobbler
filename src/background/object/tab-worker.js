import { contextMenus, tabs } from 'webextension-polyfill';

import { injectConnector } from '@/background/browser/inject';
import BrowserAction from '@/background/browser/browser-action';

import Options from '@/background/storage/options';

import Controller from '@/background/object/controller';
import {
	isActiveMode,
	isInactiveMode,
} from '@/background/object/controller-mode';

import { INJECTED, MATCHED, NO_MATCH } from '@/background/object/inject-result';
import { getCurrentTab } from '@/common/util-browser';
import { getConnectorByUrl } from '@/common/util-connector';

import { L } from '@/common/i18n';

import {
	EVENT_STATE_CHANGED,
	EVENT_TRACK_UPDATED,
	REQUEST_CORRECT_TRACK,
	REQUEST_GET_CONNECTOR_LABEL,
	REQUEST_GET_TRACK,
	REQUEST_RESET_TRACK,
	REQUEST_SKIP_TRACK,
	REQUEST_TOGGLE_LOVE,
	sendMessageToAll,
} from '@/common/messages';

export default class TabWorker {
	constructor() {
		this.initialize();
	}

	/** Listeners. */

	/**
	 * Called if a new event is dispatched.
	 *
	 * @param {Object} ctrl Controller instance
	 * @param {Object} event Event generated by the controller.
	 */
	// eslint-disable-next-line no-unused-vars
	onControllerEvent(ctrl, event) {
		throw new Error('This function must be overridden!');
	}

	/** Public methods. */

	/**
	 * Returna an ID of the current tab.
	 *
	 * @return {Number} Tab ID
	 */
	getActiveTabId() {
		return this.activeTabId;
	}

	/**
	 * Called when a command is executed.
	 *
	 * @param {String} command Command ID
	 */
	async processCommand(command) {
		const ctrl =
			this.tabControllers[this.activeTabId] ||
			this.tabControllers[this.currentTabId];
		if (!ctrl) {
			return;
		}

		switch (command) {
			case 'toggle-connector':
				this.setControllerState(ctrl, !ctrl.isEnabled);
				break;

			case 'love-song':
			case 'unlove-song': {
				const isLoved = command === 'love-song';

				await ctrl.toggleLove(isLoved);
				this.browserAction.setSongLoved(isLoved, ctrl.getCurrentSong());
				break;
			}
		}
	}

	/**
	 * Called when a message from another extension is received.
	 *
	 * @param {Object} type Message type
	 *
	 * @return {Object} Request response
	 */
	processExternalPortMessage(type) {
		if (type === REQUEST_GET_TRACK) {
			let trackInfo = null;
			const activeCtrl = this.tabControllers[this.activeTabId];

			if (activeCtrl) {
				const song = activeCtrl.getCurrentSong();
				trackInfo = song && song.getInfo();
			}

			return { trackInfo };
		}

		return null;
	}

	/**
	 * Called when something sent message to the background script
	 * via `browser.runtime.sendMessage` function.
	 *
	 * @param {Number} tabId ID of a tab to which the message is addressed
	 * @param {String} type Message type
	 * @param {Object} data Object contains data sent in the message
	 */
	async processMessage(tabId, type, data) {
		const ctrl = this.tabControllers[tabId];

		if (!ctrl) {
			console.warn(
				`Attempted to send ${type} event to controller for tab ${tabId}`
			);
			return;
		}

		switch (type) {
			case REQUEST_GET_TRACK:
				return ctrl.getCurrentSong().getCloneableData();

			case REQUEST_GET_CONNECTOR_LABEL:
				return ctrl.getConnector().label;

			case REQUEST_CORRECT_TRACK:
				ctrl.setUserSongData(data.track);
				break;

			case REQUEST_TOGGLE_LOVE:
				await ctrl.toggleLove(data.isLoved);
				break;

			case REQUEST_SKIP_TRACK:
				ctrl.skipCurrentSong();
				break;

			case REQUEST_RESET_TRACK:
				ctrl.resetSongData();
				break;
		}
	}

	/**
	 * Called when something sent message to the background script via port.
	 *
	 * @param {Number} tabId ID of a tab to which the message is addressed
	 * @param {String} type Message type
	 * @param {Object} data Object contains data sent in the message
	 */
	processPortMessage(tabId, type, data) {
		switch (type) {
			case EVENT_STATE_CHANGED: {
				const ctrl = this.tabControllers[tabId];
				if (ctrl) {
					ctrl.processStateChange(data);
				}
				break;
			}
		}
	}

	/**
	 * Called when a tab is updated.
	 *
	 * @param {Number} tabId Tab ID
	 * @param {String} url Object contains changes of updated tab
	 */
	async processTabUpdate(tabId, url) {
		const connector = await getConnectorByUrl(url);
		this.tryToInjectConnector(tabId, connector);
	}

	/**
	 * Called when a current tab is changed.
	 *
	 * @param {Number} tabId Tab ID
	 */
	processTabChange(tabId) {
		this.currentTabId = tabId;

		if (this.shouldUpdateBrowserAction(tabId)) {
			this.updateBrowserAction(tabId);
			this.activeTabId = tabId;
		}

		this.updateContextMenu(tabId);
	}

	/**
	 * Called when a tab is removed.
	 *
	 * @param {Number} removedTabId Tab ID
	 */
	async processTabRemove(removedTabId) {
		this.unloadController(removedTabId);

		if (removedTabId === this.activeTabId) {
			this.activeTabId = tabs.TAB_ID_NONE;
			this.updateLastActiveTab();
		}
	}

	/** Private methods. */

	async initialize() {
		const currentTab = await getCurrentTab();
		// We cannot get a current tab in some cases on startup
		if (currentTab) {
			this.currentTabId = currentTab.id;
		} else {
			this.currentTabId = tabs.TAB_ID_NONE;
		}
		this.activeTabId = tabs.TAB_ID_NONE;
		this.tabControllers = [];

		this.browserAction = new BrowserAction();
		/*
		 * Prevent restoring the browser action icon
		 * from the previous session.
		 */
		this.browserAction.reset();
	}

	/**
	 * Update the browser action in context of a given tab ID.
	 *
	 * @param {Number} tabId Tab ID
	 */
	updateBrowserAction(tabId) {
		const ctrl = this.tabControllers[tabId];
		if (ctrl) {
			this.browserAction.update(ctrl);
		} else {
			this.browserAction.reset();
		}
	}

	/**
	 * Check if the browser action should be updated
	 * in context of a given tab ID.
	 *
	 * @param {Number} tabId Tab ID
	 *
	 * @return {Boolean} Check result
	 */
	shouldUpdateBrowserAction(tabId) {
		const activeCtrl = this.tabControllers[this.activeTabId];
		if (activeCtrl && isActiveMode(activeCtrl.mode)) {
			return false;
		}

		const ctrl = this.tabControllers[tabId];
		if (ctrl) {
			if (tabId !== this.currentTabId && isInactiveMode(ctrl.mode)) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Get ID of a tab with recent active controller.
	 *
	 * @return {Number} Tab ID
	 */
	findActiveTabId() {
		const ctrl = this.tabControllers[this.currentTabId];
		if (ctrl && isActiveMode(ctrl.mode)) {
			return this.currentTabId;
		}

		for (const tabId in this.tabControllers) {
			const ctrl = this.tabControllers[tabId];
			const mode = ctrl.getMode();
			if (isActiveMode(mode)) {
				// NOTE: Don't use `tabId` directly, it's a string.
				return ctrl.tabId;
			}
		}

		if (ctrl) {
			return this.currentTabId;
		}

		return tabs.TAB_ID_NONE;
	}

	/**
	 * Update the browser action and the context menu in context of a last
	 * active tab. If no active tab is found, reset the browser action icon
	 * and the context menu.
	 */
	updateLastActiveTab() {
		const lastActiveTabId = this.findActiveTabId();
		if (lastActiveTabId !== tabs.TAB_ID_NONE) {
			this.activeTabId = lastActiveTabId;

			this.updateBrowserAction(this.activeTabId);
			this.updateContextMenu(this.activeTabId);
		} else {
			this.browserAction.reset();
			this.resetContextMenu();
		}
	}

	/**
	 * Setup context menu of the browser action for a tab with given tab ID.
	 *
	 * @param {Number} tabId Tab ID
	 */
	updateContextMenu(tabId) {
		this.resetContextMenu();

		const ctrl = this.tabControllers[tabId];

		// Always display context menu for current tab
		if (ctrl) {
			this.addToggleConnectorMenu(tabId, ctrl);
			if (ctrl.isEnabled) {
				this.addDisableUntilTabClosedItem(tabId, ctrl);
			}
		}

		// Add additional menu items for active tab (if it's not current)...
		if (this.activeTabId !== tabId) {
			const activeCtrl = this.tabControllers[this.activeTabId];

			if (activeCtrl) {
				if (
					ctrl &&
					activeCtrl.getConnector().id === ctrl.getConnector().id
				) {
					return;
				}

				// ...but only if it has a different connector injected.
				this.addToggleConnectorMenu(tabId, activeCtrl);
			}
		}
	}

	/**
	 * Remove all items from the context menu.
	 */
	resetContextMenu() {
		contextMenus.removeAll();
	}

	/**
	 * Add a "Enable/Disable X" menu item for a given controller.
	 *
	 * @param {Number} tabId Tab ID
	 * @param {Object} ctrl Controller instance
	 */
	addToggleConnectorMenu(tabId, ctrl) {
		const { label } = ctrl.getConnector();
		const titleId = ctrl.isEnabled
			? 'menuDisableConnector'
			: 'menuEnableConnector';
		const itemTitle = L(titleId, label);
		const newState = !ctrl.isEnabled;

		this.addContextMenuItem(tabId, itemTitle, () => {
			this.setConnectorState(ctrl, newState);
		});
	}

	/**
	 * Add a "Disable X until tab is closed" menu item for a given controller.
	 *
	 * @param {Number} tabId Tab ID
	 * @param {Object} ctrl Controller instance
	 */
	addDisableUntilTabClosedItem(tabId, ctrl) {
		const { label } = ctrl.getConnector();
		const itemTitle2 = L('menuDisableUntilTabClosed', label);
		this.addContextMenuItem(tabId, itemTitle2, () => {
			ctrl.setEnabled(false);
		});
	}

	/**
	 * Helper function to add item to page action context menu.
	 *
	 * @param {Number} tabId Tab ID
	 * @param {String} title Item title
	 * @param {Function} onClicked Function that will be called on item click
	 */
	addContextMenuItem(tabId, title, onClicked) {
		const onclick = () => {
			onClicked();

			this.updateContextMenu(tabId);
			if (this.shouldUpdateBrowserAction(tabId)) {
				this.updateBrowserAction(tabId);
			}
		};

		const type = 'normal';
		contextMenus.create({
			title,
			type,
			onclick,
			contexts: ['browser_action'],
		});
	}

	/**
	 * Called when a controller changes its mode.
	 *
	 * @param {Object} ctrl  Controller instance
	 * @param {Number} tabId ID of a tab attached to the controller
	 */
	processControlleModeChange(ctrl, tabId) {
		const mode = ctrl.getMode();
		const isCtrlModeInactive = isInactiveMode(mode);
		let isActiveCtrlChanged = false;

		if (this.activeTabId !== tabId) {
			if (isCtrlModeInactive) {
				return;
			}

			this.activeTabId = tabId;
			isActiveCtrlChanged = true;
		}

		if (isActiveCtrlChanged) {
			this.updateContextMenu(this.currentTabId);
		}

		if (isCtrlModeInactive) {
			// Use the current tab as a context
			this.updateBrowserAction(this.currentTabId);
		} else {
			// Use a tab to which the given controller attached as a context
			this.updateBrowserAction(tabId);
		}
	}

	/**
	 * Notify other modules if a controller updated the song.
	 *
	 * @param {Object} ctrl Controller instance
	 */
	async notifySongIsUpdated(ctrl) {
		const track = ctrl.getCurrentSong().getCloneableData();

		try {
			await sendMessageToAll(EVENT_TRACK_UPDATED, { track });
		} catch (e) {
			// Suppress errors
		}
	}

	/**
	 * Make an attempt to inject a connector into a page.
	 *
	 * @param {Number} tabId An ID of a tab where the connector will be injected
	 * @param {String} connector Connector match object
	 *
	 * @return {Object} InjectResult value
	 */
	async tryToInjectConnector(tabId, connector) {
		const result = await injectConnector(tabId, connector);

		switch (result) {
			case INJECTED: {
				return;
			}

			case NO_MATCH: {
				if (this.tabControllers[tabId]) {
					this.unloadController(tabId);
					this.updateLastActiveTab();
				}
				break;
			}

			case MATCHED: {
				this.unloadController(tabId);
				this.createController(tabId, connector);

				if (this.shouldUpdateBrowserAction(tabId)) {
					this.updateBrowserAction(tabId);
				}
				this.updateContextMenu(tabId);

				tabs.sendMessage(tabId, { type: 'EVENT_READY' });
				break;
			}
		}
	}

	/**
	 * Create a controller for a tab.
	 *
	 * @param {Number} tabId An ID of a tab bound to the controller
	 * @param {Object} connector A connector match object
	 */
	createController(tabId, connector) {
		const isEnabled = Options.isConnectorEnabled(connector);
		const ctrl = new Controller(tabId, connector, isEnabled);
		ctrl.onSongUpdated = async () => {
			this.notifySongIsUpdated(ctrl);
		};
		ctrl.onModeChanged = () => {
			this.processControlleModeChange(ctrl, tabId);
		};
		ctrl.onControllerEvent = (event) => {
			this.onControllerEvent(ctrl, event);
		};

		this.tabControllers[tabId] = ctrl;
	}

	/**
	 * Stop and remove controller for a tab with a given tab ID.
	 *
	 * @param {Number} tabId Tab ID
	 */
	async unloadController(tabId) {
		const controller = this.tabControllers[tabId];
		if (!controller) {
			return;
		}

		controller.finish();
		delete this.tabControllers[tabId];
	}

	/**
	 * Enable or disable a connector attached to a given controller.
	 *
	 * @param {Object} ctrl Controller instance
	 * @param {Boolean} isEnabled Flag value
	 */
	setConnectorState(ctrl, isEnabled) {
		const connector = ctrl.getConnector();

		ctrl.setEnabled(isEnabled);
		Options.setConnectorEnabled(connector, isEnabled);
	}
}
