/** @odoo-module */

import { markRaw } from "@odoo/owl";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { PosStore } from "@point_of_sale/app/store/pos_store";
import { ErrorPopup } from "@point_of_sale/app/errors/popups/error_popup";
import { ConfirmPopup } from "@point_of_sale/app/utils/confirm_popup/confirm_popup";

export const PRSQ_EPSILON = 1e-6;

/**
 * Stock data model
 * ----------------
 * prsqStockMap      Map<productId, [onHand, forecast]> coming from the server
 *                   (embedded in the initial payload, refreshed in background).
 *                   Only storable products are present.
 * prsqPendingSynced Map<productId, qty> sold in orders already synced to the
 *                   server but not yet reflected in the last stock map.
 * Reserved quantity = open (non finalized) orders of this POS
 *                   + paid orders waiting to be synced (offline)
 *                   + prsqPendingSynced.
 * Displayed/available quantity = server quantity - reserved quantity.
 * Both maps are markRaw (not reactive) for performance; a single reactive
 * counter (prsqStockRevision) triggers the re-rendering.
 */
patch(PosStore.prototype, {
    async _processData(loadedData) {
        const settings = loadedData["prsq_settings"] || { active: false };
        this.prsqSettings = settings;
        this.prsqStockMap = markRaw(new Map());
        this.prsqPendingSynced = markRaw(new Map());
        this.prsqExemptIds = markRaw(new Set(settings.exempt_product_ids || []));
        this.prsqStockRevision = 0;
        this.prsqLastRefresh = null;
        this.prsqRefreshing = false;
        await super._processData(...arguments);
    },

    _loadProductProduct(products) {
        if (this.prsqStockMap) {
            for (const product of products) {
                if (product.prsq_stock) {
                    this.prsqStockMap.set(product.id, product.prsq_stock.slice());
                } else if (product.prsq_stock === false) {
                    this.prsqStockMap.delete(product.id);
                }
            }
            this.prsqStockRevision++;
        }
        return super._loadProductProduct(...arguments);
    },

    async after_load_server_data() {
        const result = await super.after_load_server_data(...arguments);
        this.prsqLastRefresh = new Date();
        this._prsqStartAutoRefresh();
        return result;
    },

    _prsqStartAutoRefresh() {
        const minutes = this.prsqSettings && this.prsqSettings.refresh_interval;
        if (!this.prsqSettings.active || !minutes || minutes <= 0) {
            return;
        }
        if (this.unwatched.prsqTimer) {
            clearInterval(this.unwatched.prsqTimer);
        }
        this.unwatched.prsqTimer = setInterval(() => this.prsqRefreshStock(), minutes * 60 * 1000);
    },

    // ------------------------------------------------------------------
    // Sync hooks
    // ------------------------------------------------------------------
    async _save_to_server(orders, options) {
        const isDraft = Boolean(options && options.draft);
        const serverIds = await super._save_to_server(...arguments);
        if (!isDraft && this.prsqSettings && this.prsqSettings.active && serverIds && serverIds.length) {
            const syncedRefs = new Set(serverIds.map((s) => s.pos_reference));
            const syncedOrders = (orders || []).filter((o) => o.data && syncedRefs.has(o.data.name));
            this._prsqOnOrdersSynced(syncedOrders);
        }
        return serverIds;
    },

    _prsqOnOrdersSynced(orders) {
        const quantities = this._prsqQuantitiesFromOrderData(orders);
        if (!quantities.size) {
            return;
        }
        for (const [productId, qty] of quantities) {
            this.prsqPendingSynced.set(productId, (this.prsqPendingSynced.get(productId) || 0) + qty);
        }
        // Fire and forget: the cashier is never blocked by the refresh.
        this.prsqRefreshStock([...quantities.keys()]);
    },

    _prsqQuantitiesFromOrderData(orders) {
        const quantities = new Map();
        for (const order of orders || []) {
            for (const command of (order.data && order.data.lines) || []) {
                const vals = command[2] || {};
                if (!this.prsqStockMap.has(vals.product_id) || !(vals.qty > 0)) {
                    continue;
                }
                quantities.set(vals.product_id, (quantities.get(vals.product_id) || 0) + vals.qty);
            }
        }
        return quantities;
    },

    /**
     * Reload quantities from the server.
     * @param {number[]} [productIds] defaults to every tracked product
     * @returns {Promise<boolean>} true when the refresh succeeded
     */
    async prsqRefreshStock(productIds) {
        if (!this.prsqSettings || !this.prsqSettings.active) {
            return false;
        }
        const ids = productIds ? [...productIds] : [...this.prsqStockMap.keys()];
        if (!ids.length) {
            return true;
        }
        const snapshot = new Map();
        for (const id of ids) {
            if (this.prsqPendingSynced.has(id)) {
                snapshot.set(id, this.prsqPendingSynced.get(id));
            }
        }
        this.prsqRefreshing = true;
        try {
            const result = await this.orm.silent.call("pos.session", "prsq_get_stock_map", [
                [this.pos_session.id],
                ids,
            ]);
            this._prsqApplyStock(ids, (result && result.stock) || {}, snapshot);
            return true;
        } catch (error) {
            console.warn("pos_restrict_stock_quantity: stock refresh failed", error);
            return false;
        } finally {
            this.prsqRefreshing = false;
        }
    },

    _prsqApplyStock(ids, stock, snapshot) {
        for (const id of ids) {
            const values = stock[String(id)];
            if (values) {
                this.prsqStockMap.set(id, values);
            } else {
                this.prsqStockMap.delete(id);
            }
        }
        // The server now includes the quantities captured before the call.
        for (const [id, qty] of snapshot) {
            const remaining = (this.prsqPendingSynced.get(id) || 0) - qty;
            if (remaining > PRSQ_EPSILON) {
                this.prsqPendingSynced.set(id, remaining);
            } else {
                this.prsqPendingSynced.delete(id);
            }
        }
        this.prsqLastRefresh = new Date();
        this.prsqStockRevision++;
    },

    // ------------------------------------------------------------------
    // Product click: refuse early in "block" mode (before lot / attribute
    // / weight popups). Order.add_product stays the single source of truth.
    // ------------------------------------------------------------------
    async addProductToCurrentOrder(product, options = {}) {
        if (Number.isInteger(product)) {
            product = this.db.get_product_by_id(product);
        }
        if (this.prsqMustCheck(product) && this.prsqSettings.mode === "block") {
            const requested = options.quantity > 0 ? parseFloat(options.quantity) : 1;
            const { allowed, available } = this.prsqCheckAvailability(product, requested);
            if (!allowed) {
                await this.prsqNotifyShortage(product, available, requested);
                return;
            }
        }
        return super.addProductToCurrentOrder(product, options);
    },

    // ------------------------------------------------------------------
    // Stock helpers
    // ------------------------------------------------------------------
    prsqIsTracked(product) {
        return Boolean(
            this.prsqSettings && this.prsqSettings.active && product && this.prsqStockMap.has(product.id)
        );
    },

    prsqIsExempt(product) {
        return Boolean(product && this.prsqExemptIds && this.prsqExemptIds.has(product.id));
    },

    /** True when the restriction rule applies to this product. */
    prsqMustCheck(product) {
        return Boolean(
            this.prsqSettings &&
                this.prsqSettings.restrict &&
                this.prsqIsTracked(product) &&
                !this.prsqIsExempt(product)
        );
    },

    /**
     * Quantity of a product already "taken" locally.
     * @param {number} productId
     * @param {Object} [exclude] { line, order } to ignore
     */
    prsqGetReservedQty(productId, exclude = {}) {
        const excludeLine = exclude.line;
        const excludeOrder = exclude.order;
        let qty = 0;
        for (const order of this.get_order_list()) {
            if (order.finalized || (excludeOrder && order.uid === excludeOrder.uid)) {
                continue;
            }
            for (const line of order.get_orderlines()) {
                if (line.product.id !== productId || (excludeLine && line.id === excludeLine.id)) {
                    continue;
                }
                const lineQty = line.get_quantity();
                if (lineQty > 0) {
                    qty += lineQty;
                }
            }
        }
        // Paid orders not synced yet (e.g. offline).
        for (const order of this.db.get_orders()) {
            if (excludeOrder && order.id === excludeOrder.uid) {
                continue;
            }
            for (const command of (order.data && order.data.lines) || []) {
                const vals = command[2] || {};
                if (vals.product_id === productId && vals.qty > 0) {
                    qty += vals.qty;
                }
            }
        }
        qty += this.prsqPendingSynced.get(productId) || 0;
        return qty;
    },

    /**
     * @returns {Object|null} stock information of a tracked product
     */
    prsqGetStockInfo(product, exclude) {
        if (!this.prsqIsTracked(product)) {
            return null;
        }
        const [onHand, forecast] = this.prsqStockMap.get(product.id);
        const reserved = this.prsqGetReservedQty(product.id, exclude);
        return {
            onHand: onHand - reserved,
            forecast: forecast - reserved,
            reserved,
            serverOnHand: onHand,
            serverForecast: forecast,
            exempt: this.prsqIsExempt(product),
        };
    },

    /**
     * Everything the product card needs, or undefined when nothing is shown.
     * Reading prsqStockRevision subscribes the card to stock refreshes.
     */
    prsqGetCardInfo(product) {
        const settings = this.prsqSettings;
        if (!settings || !settings.active || this.prsqStockRevision < 0) {
            return undefined;
        }
        const stock = this.prsqGetStockInfo(product);
        if (!stock) {
            return undefined;
        }
        const available = settings.basis === "forecast" ? stock.forecast : stock.onHand;
        const blocked = this.prsqMustCheck(product) && available <= 0;
        const classes = ["prsq-tracked"];
        if (blocked) {
            classes.push("prsq-blocked");
        }
        if (stock.exempt) {
            classes.push("prsq-exempt");
        }
        return {
            showOnHand: Boolean(settings.show_stock),
            showForecast: Boolean(settings.show_forecast),
            showExempt: Boolean(stock.exempt && settings.restrict),
            onHand: stock.onHand,
            forecast: stock.forecast,
            onHandTxt: this.prsqFormatQty(stock.onHand),
            forecastTxt: this.prsqFormatQty(stock.forecast),
            isIn: stock.onHand > 0,
            blocked,
            cardClass: classes.join(" "),
        };
    },

    /**
     * Check if `requestedQty` units can be sold.
     * @returns {{allowed: boolean, available: number}}
     */
    prsqCheckAvailability(product, requestedQty, exclude) {
        if (!this.prsqMustCheck(product) || !(requestedQty > 0)) {
            return { allowed: true, available: Infinity };
        }
        const info = this.prsqGetStockInfo(product, exclude);
        const available = this.prsqSettings.basis === "forecast" ? info.forecast : info.onHand;
        return { allowed: requestedQty <= available + PRSQ_EPSILON, available };
    },

    /** Compact quantity: "12" instead of "12.00", decimals kept when needed. */
    prsqFormatQty(qty) {
        return this.env.utils.formatProductQty(qty, false);
    },

    _prsqUomName(product) {
        const uom = product.uom_id && this.units_by_id[product.uom_id[0]];
        return uom ? uom.name : "";
    },

    prsqShortageMessage(product, available, requested) {
        const location = this.prsqSettings.location_name || _t("this location");
        let message;
        if (available <= PRSQ_EPSILON) {
            message = _t('"%s" is out of stock in %s.', product.display_name, location);
        } else {
            const availableTxt = `${this.prsqFormatQty(available)} ${this._prsqUomName(product)}`.trim();
            message = _t(
                'Only %s of "%s" available in %s.',
                availableTxt,
                product.display_name,
                location
            );
        }
        if (requested !== undefined) {
            // One sentence per line keeps mixed Arabic / Latin text readable.
            message += "\n" + _t("Requested quantity: %s.", this.prsqFormatQty(requested));
        }
        return message;
    },

    /**
     * Display the restriction popup. In "warn" mode `onOverride` is
     * called when the cashier confirms the sale anyway.
     */
    async prsqNotifyShortage(product, available, requested, onOverride) {
        if (this.unwatched.prsqPopupOpen) {
            return false;
        }
        this.unwatched.prsqPopupOpen = true;
        try {
            const body = this.prsqShortageMessage(product, available, requested);
            if (this.prsqSettings.mode === "warn") {
                const { confirmed } = await this.popup.add(ConfirmPopup, {
                    title: _t("Insufficient Stock"),
                    body: body + "\n" + _t("Do you want to sell it anyway?"),
                    confirmText: _t("Sell Anyway"),
                    cancelText: _t("Cancel"),
                });
                if (confirmed && onOverride) {
                    await onOverride();
                }
                return confirmed;
            }
            await this.popup.add(ErrorPopup, {
                title: _t("Out of Stock"),
                body: body + "\n" + _t("This product cannot be sold beyond its available quantity."),
            });
            return false;
        } finally {
            this.unwatched.prsqPopupOpen = false;
        }
    },

    /**
     * Products of `order` whose total quantity exceeds availability.
     */
    prsqGetOrderViolations(order) {
        const totals = new Map();
        for (const line of order.get_orderlines()) {
            if (!this.prsqMustCheck(line.product)) {
                continue;
            }
            const qty = line.get_quantity();
            if (qty > 0) {
                if (!totals.has(line.product.id)) {
                    totals.set(line.product.id, { product: line.product, qty: 0 });
                }
                totals.get(line.product.id).qty += qty;
            }
        }
        const violations = [];
        for (const { product, qty } of totals.values()) {
            const { allowed, available } = this.prsqCheckAvailability(product, qty, { order });
            if (!allowed) {
                violations.push({ product, requested: qty, available });
            }
        }
        return violations;
    },
});
