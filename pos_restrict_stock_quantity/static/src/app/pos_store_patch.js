/** @odoo-module */

import { markRaw } from "@odoo/owl";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { ask } from "@point_of_sale/app/utils/make_awaitable_dialog";

export const PRSQ_EPSILON = 1e-6;

/** Odoo 18 records have no access to the store: keep a reference here. */
export const prsqStoreRef = { pos: null };

/**
 * Stock data model (Odoo 19)
 * --------------------------
 * The server sends `pos.config._prsq_settings` and `pos.config._prsq_stock_map`
 * ({"<product id>": [onHand, forecast] | false}) with the initial data.
 *
 * prsqStockMap      Map<productId, [onHand, forecast]> (storable products only)
 * prsqUntracked     Set<productId> consumables / services / combos
 * prsqPendingSynced Map<productId, qty> sold in orders already synced to the
 *                   server but not yet reflected in the last stock map.
 * Reserved quantity = open orders of this POS + paid orders waiting to be
 *                     synced (offline) + prsqPendingSynced.
 * Displayed/available quantity = server quantity - reserved quantity.
 * Maps are markRaw (not reactive); a reactive counter (prsqStockRevision)
 * triggers the re-rendering.
 */
patch(PosStore.prototype, {
    async processServerData() {
        await super.processServerData(...arguments);
        prsqStoreRef.pos = this;
        const settings = this.config._prsq_settings || { active: false };
        this.prsqSettings = settings;
        this.prsqStockMap = markRaw(new Map());
        this.prsqUntracked = markRaw(new Set());
        this.prsqPendingSynced = markRaw(new Map());
        this.prsqToFetch = markRaw(new Set());
        this.prsqExemptIds = markRaw(new Set(settings.exempt_product_ids || []));
        this.prsqStockRevision = 0;
        this.prsqLastRefresh = null;
        this.prsqRefreshing = false;
        this._prsqStoreStock(this.config._prsq_stock_map || {});
    },

    async afterProcessServerData() {
        const result = await super.afterProcessServerData(...arguments);
        if (this.prsqSettings && this.prsqSettings.active) {
            this.prsqLastRefresh = new Date();
            this._prsqStartAutoRefresh();
            // Products restored from the local cache (IndexedDB) are not in
            // the map sent by the server: fetch them once in background.
            this._prsqFetchUnknown(this.models["product.product"].getAll().map((p) => p.id));
        }
        return result;
    },

    _prsqStoreStock(stock) {
        for (const [key, values] of Object.entries(stock)) {
            const id = parseInt(key);
            if (values) {
                this.prsqStockMap.set(id, values);
                this.prsqUntracked.delete(id);
            } else {
                this.prsqStockMap.delete(id);
                this.prsqUntracked.add(id);
            }
        }
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

    /**
     * Products loaded after the start (search, barcode, local cache) are
     * fetched once, in background, by small batches.
     */
    _prsqFetchUnknown(ids) {
        let added = false;
        for (const id of ids) {
            if (
                typeof id === "number" &&
                !this.prsqStockMap.has(id) &&
                !this.prsqUntracked.has(id) &&
                !this.prsqToFetch.has(id)
            ) {
                this.prsqToFetch.add(id);
                added = true;
            }
        }
        if (added && !this.unwatched.prsqFetchTimer) {
            this.unwatched.prsqFetchTimer = setTimeout(() => {
                this.unwatched.prsqFetchTimer = null;
                const batch = [...this.prsqToFetch];
                this.prsqRefreshStock(batch).finally(() => {
                    batch.forEach((id) => this.prsqToFetch.delete(id));
                });
            }, 200);
        }
    },

    // ------------------------------------------------------------------
    // Sync hook: quantities of orders just synced stay deducted until the
    // next server refresh, which is triggered right away in background.
    // ------------------------------------------------------------------
    async postSyncAllOrders(orders) {
        await super.postSyncAllOrders(...arguments);
        if (!this.prsqSettings || !this.prsqSettings.active) {
            return;
        }
        const quantities = new Map();
        for (const order of orders || []) {
            if (!order.finalized) {
                continue;
            }
            for (const line of order.lines || []) {
                const productId = line.product_id && line.product_id.id;
                const qty = line.getQuantity();
                if (!this.prsqStockMap.has(productId) || !(qty > 0)) {
                    continue;
                }
                quantities.set(productId, (quantities.get(productId) || 0) + qty);
            }
        }
        if (!quantities.size) {
            return;
        }
        for (const [productId, qty] of quantities) {
            this.prsqPendingSynced.set(productId, (this.prsqPendingSynced.get(productId) || 0) + qty);
        }
        this.prsqStockRevision++;
        // Fire and forget: the cashier is never blocked by the refresh.
        this.prsqRefreshStock([...quantities.keys()]);
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
            const result = await this.data.call("pos.session", "prsq_get_stock_map", [
                [this.session.id],
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
        const normalized = {};
        for (const id of ids) {
            normalized[String(id)] = stock[String(id)] || false;
        }
        this._prsqStoreStock(normalized);
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
    // Every new line goes through addLineToOrder (click, barcode, search).
    // In Odoo 19 the variant is only known once the configurator has run:
    // the check runs right after it (in handleComboProduct, called next),
    // and before the lot / weight dialogs.
    // ------------------------------------------------------------------
    async addLineToOrder(vals, order, opts = {}, configure = true) {
        // The new quantity is checked once below: do not check it again when
        // the new line is merged into an existing one.
        this.unwatched.prsqBypassAll = (this.unwatched.prsqBypassAll || 0) + 1;
        try {
            return await super.addLineToOrder(vals, order, opts, configure);
        } finally {
            this.unwatched.prsqBypassAll--;
        }
    },

    async handleComboProduct(values, order, configure = true, extra = {}) {
        if (!extra.line) {
            const product = values.product_id;
            if (product && this.prsqMustCheck(product)) {
                const requested = values.qty !== undefined ? parseFloat(values.qty) : 1;
                if (requested > 0) {
                    const { allowed, available } = this.prsqCheckAvailability(product, requested);
                    if (!allowed) {
                        const override = await this.prsqNotifyShortage(product, available, requested);
                        if (!override) {
                            return false;
                        }
                    }
                }
            }
        }
        return super.handleComboProduct(...arguments);
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
        for (const order of this.models["pos.order"].getAll()) {
            // Open orders and paid orders still waiting to be synced.
            if (order.finalized && !order.isUnsyncedPaid) {
                continue;
            }
            if (order.state === "cancel" || (excludeOrder && order.uuid === excludeOrder.uuid)) {
                continue;
            }
            for (const line of order.lines) {
                if (
                    !line.product_id ||
                    line.product_id.id !== productId ||
                    (excludeLine && line.uuid === excludeLine.uuid)
                ) {
                    continue;
                }
                const lineQty = line.getQuantity();
                if (lineQty > 0) {
                    qty += lineQty;
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
     * Odoo 19 cards show product templates: quantities of the variants are
     * added up, and the card is "blocked" only when no variant can be sold.
     * Reading prsqStockRevision subscribes the card to stock refreshes.
     */
    prsqGetCardInfo(template) {
        const settings = this.prsqSettings;
        if (!settings || !settings.active || this.prsqStockRevision < 0 || !template) {
            return undefined;
        }
        const variants = template.product_variant_ids || [];
        const unknown = variants
            .map((v) => v.id)
            .filter((id) => !this.prsqStockMap.has(id) && !this.prsqUntracked.has(id));
        if (unknown.length) {
            this._prsqFetchUnknown(unknown);
        }
        let tracked = 0;
        let onHand = 0;
        let forecast = 0;
        let sellable = false;
        let restricted = false;
        let exempt = false;
        for (const variant of variants) {
            const stock = this.prsqGetStockInfo(variant);
            if (!stock) {
                if (this.prsqUntracked.has(variant.id)) {
                    sellable = true;
                }
                continue;
            }
            tracked++;
            onHand += stock.onHand;
            forecast += stock.forecast;
            exempt = exempt || stock.exempt;
            if (this.prsqMustCheck(variant)) {
                restricted = true;
                const available = settings.basis === "forecast" ? stock.forecast : stock.onHand;
                sellable = sellable || available > 0;
            } else {
                sellable = true;
            }
        }
        if (!tracked) {
            return undefined;
        }
        const blocked = restricted && !sellable;
        const classes = ["prsq-tracked"];
        if (blocked) {
            classes.push("prsq-blocked");
        }
        if (exempt) {
            classes.push("prsq-exempt");
        }
        return {
            showOnHand: Boolean(settings.show_stock),
            showForecast: Boolean(settings.show_forecast),
            showExempt: Boolean(exempt && settings.restrict),
            onHand,
            forecast,
            onHandTxt: this.prsqFormatQty(onHand),
            forecastTxt: this.prsqFormatQty(forecast),
            isIn: onHand > 0,
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

    /** Product name without the "[reference]" prefix Odoo 19 adds. */
    prsqProductName(product) {
        return (product.display_name || product.name || "").replace(/^\[[^\]]*\]\s*/, "");
    },

    prsqShortageMessage(product, available, requested) {
        const location = this.prsqSettings.location_name || _t("this location");
        let message;
        if (available <= PRSQ_EPSILON) {
            message = _t('"%s" is out of stock in %s.', this.prsqProductName(product), location);
        } else {
            const uomRecord = product.uom_id || (product.product_tmpl_id && product.product_tmpl_id.uom_id);
            const uom = uomRecord ? uomRecord.name : "";
            const availableTxt = `${this.prsqFormatQty(available)} ${uom}`.trim();
            message = _t(
                'Only %s of "%s" available in %s.',
                availableTxt,
                this.prsqProductName(product),
                location
            );
        }
        if (requested !== undefined) {
            // One sentence per line keeps mixed Arabic / Latin text readable.
            message += "\n" + _t("Requested quantity: %s.", this.prsqFormatQty(requested));
        }
        return message;
    },

    /** Title + body of the "block" message (also returned to the numpad). */
    prsqBlockDialogProps(product, available, requested) {
        return {
            title: _t("Out of Stock"),
            body:
                this.prsqShortageMessage(product, available, requested) +
                "\n" +
                _t("This product cannot be sold beyond its available quantity."),
        };
    },

    /**
     * Display the restriction dialog.
     * @returns {Promise<boolean>} true when the cashier chose to sell anyway
     *   ("warn" mode only)
     */
    async prsqNotifyShortage(product, available, requested) {
        if (this.unwatched.prsqDialogOpen) {
            return false;
        }
        this.unwatched.prsqDialogOpen = true;
        try {
            if (this.prsqSettings.mode === "warn") {
                return await ask(this.dialog, {
                    title: _t("Insufficient Stock"),
                    body:
                        this.prsqShortageMessage(product, available, requested) +
                        "\n" +
                        _t("Do you want to sell it anyway?"),
                    confirmLabel: _t("Sell Anyway"),
                    cancelLabel: _t("Cancel"),
                });
            }
            await new Promise((resolve) => {
                this.dialog.add(
                    AlertDialog,
                    {
                        ...this.prsqBlockDialogProps(product, available, requested),
                        confirm: () => resolve(),
                    },
                    { onClose: () => resolve() }
                );
            });
            return false;
        } finally {
            this.unwatched.prsqDialogOpen = false;
        }
    },

    /**
     * Products of `order` whose total quantity exceeds availability.
     */
    prsqGetOrderViolations(order) {
        const totals = new Map();
        for (const line of order.getOrderlines()) {
            if (!line.product_id || !this.prsqMustCheck(line.product_id)) {
                continue;
            }
            const qty = line.getQuantity();
            if (qty > 0) {
                const id = line.product_id.id;
                if (!totals.has(id)) {
                    totals.set(id, { product: line.product_id, qty: 0 });
                }
                totals.get(id).qty += qty;
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
