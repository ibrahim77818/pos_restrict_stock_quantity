odoo.define('pos_restrict_stock_quantity.models', function (require) {
    'use strict';

    const { PosGlobalState, Order, Orderline } = require('point_of_sale.models');
    const Registries = require('point_of_sale.Registries');
    const { Gui } = require('point_of_sale.Gui');
    const field_utils = require('web.field_utils');
    const core = require('web.core');
    const { markRaw, reactive } = owl;

    const _t = core._t;
    const EPSILON = 1e-6;

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
    const PrsqPosGlobalState = (PosGlobalState) => class PrsqPosGlobalState extends PosGlobalState {
        async _processData(loadedData) {
            const settings = loadedData['prsq_settings'] || { active: false };
            this.prsqSettings = settings;
            this.prsqStockMap = markRaw(new Map());
            this.prsqPendingSynced = markRaw(new Map());
            this.prsqExemptIds = markRaw(new Set(settings.exempt_product_ids || []));
            this.prsqStockRevision = 0;
            this.prsqLastRefresh = null;
            this.prsqRefreshing = false;
            await super._processData(...arguments);
        }

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
        }

        async after_load_server_data() {
            const result = await super.after_load_server_data(...arguments);
            this.prsqLastRefresh = new Date();
            this._prsqStartAutoRefresh();
            return result;
        }

        _prsqStartAutoRefresh() {
            const minutes = this.prsqSettings && this.prsqSettings.refresh_interval;
            if (!this.prsqSettings.active || !minutes || minutes <= 0) {
                return;
            }
            if (this.unwatched.prsqTimer) {
                clearInterval(this.unwatched.prsqTimer);
            }
            const pos = reactive(this);
            this.unwatched.prsqTimer = setInterval(() => pos.prsqRefreshStock(), minutes * 60 * 1000);
        }

        // ------------------------------------------------------------------
        // Sync hooks
        // ------------------------------------------------------------------
        _save_to_server(orders, options) {
            const isDraft = Boolean(options && options.draft);
            return super._save_to_server(...arguments).then((serverIds) => {
                if (!isDraft && this.prsqSettings && this.prsqSettings.active && serverIds && serverIds.length) {
                    const syncedRefs = new Set(serverIds.map((s) => s.pos_reference));
                    const syncedOrders = (orders || []).filter((o) => o.data && syncedRefs.has(o.data.name));
                    this._prsqOnOrdersSynced(syncedOrders);
                }
                return serverIds;
            });
        }

        _prsqOnOrdersSynced(orders) {
            const quantities = this._prsqQuantitiesFromOrderData(orders);
            if (!quantities.size) {
                return;
            }
            for (const [productId, qty] of quantities) {
                this.prsqPendingSynced.set(productId, (this.prsqPendingSynced.get(productId) || 0) + qty);
            }
            // Fire and forget: the cashier is never blocked by the refresh.
            reactive(this).prsqRefreshStock([...quantities.keys()]);
        }

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
        }

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
                const result = await this.env.services.rpc({
                    model: 'pos.session',
                    method: 'prsq_get_stock_map',
                    args: [[this.pos_session.id], ids],
                }, { shadow: true, timeout: 30000 });
                this._prsqApplyStock(ids, (result && result.stock) || {}, snapshot);
                return true;
            } catch (error) {
                console.warn('pos_restrict_stock_quantity: stock refresh failed', error);
                return false;
            } finally {
                this.prsqRefreshing = false;
            }
        }

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
                if (remaining > EPSILON) {
                    this.prsqPendingSynced.set(id, remaining);
                } else {
                    this.prsqPendingSynced.delete(id);
                }
            }
            this.prsqLastRefresh = new Date();
            this.prsqStockRevision++;
        }

        // ------------------------------------------------------------------
        // Stock helpers
        // ------------------------------------------------------------------
        prsqIsTracked(product) {
            return Boolean(this.prsqSettings && this.prsqSettings.active && product && this.prsqStockMap.has(product.id));
        }

        prsqIsExempt(product) {
            return Boolean(product && this.prsqExemptIds && this.prsqExemptIds.has(product.id));
        }

        /** True when the restriction rule applies to this product. */
        prsqMustCheck(product) {
            return Boolean(this.prsqSettings && this.prsqSettings.restrict && this.prsqIsTracked(product) && !this.prsqIsExempt(product));
        }

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
        }

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
        }

        /**
         * Check if `requestedQty` units can be sold.
         * @returns {{allowed: boolean, available: number}}
         */
        prsqCheckAvailability(product, requestedQty, exclude) {
            if (!this.prsqMustCheck(product) || !(requestedQty > 0)) {
                return { allowed: true, available: Infinity };
            }
            const info = this.prsqGetStockInfo(product, exclude);
            const available = this.prsqSettings.basis === 'forecast' ? info.forecast : info.onHand;
            return { allowed: requestedQty <= available + EPSILON, available };
        }

        /** Compact quantity: "12" instead of "12.00", decimals kept when needed. */
        prsqFormatQty(qty) {
            const digits = this.dp['Product Unit of Measure'];
            const rounded = Math.round(qty * Math.pow(10, digits)) / Math.pow(10, digits);
            return field_utils.format.float(rounded, {
                digits: [69, Number.isInteger(rounded) ? 0 : digits],
            });
        }

        _prsqUomName(product) {
            const uom = product.uom_id && this.units_by_id[product.uom_id[0]];
            return uom ? uom.name : '';
        }

        prsqShortageMessage(product, available, requested) {
            const location = this.prsqSettings.location_name || _t('this location');
            let message;
            if (available <= EPSILON) {
                message = _.str.sprintf(_t('"%s" is out of stock in %s.'), product.display_name, location);
            } else {
                const availableTxt = `${this.prsqFormatQty(available)} ${this._prsqUomName(product)}`.trim();
                message = _.str.sprintf(
                    _t('Only %s of "%s" available in %s.'),
                    availableTxt, product.display_name, location
                );
            }
            if (requested !== undefined) {
                // One sentence per line keeps mixed Arabic / Latin text readable.
                message += '\n' + _.str.sprintf(_t('Requested quantity: %s.'), this.prsqFormatQty(requested));
            }
            return message;
        }

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
                if (this.prsqSettings.mode === 'warn') {
                    const { confirmed } = await Gui.showPopup('ConfirmPopup', {
                        title: _t('Insufficient Stock'),
                        body: body + '\n' + _t('Do you want to sell it anyway?'),
                        confirmText: _t('Sell Anyway'),
                        cancelText: _t('Cancel'),
                    });
                    if (confirmed && onOverride) {
                        onOverride();
                    }
                    return confirmed;
                }
                await Gui.showPopup('ErrorPopup', {
                    title: _t('Out of Stock'),
                    body: body + '\n' + _t('This product cannot be sold beyond its available quantity.'),
                });
                return false;
            } finally {
                this.unwatched.prsqPopupOpen = false;
            }
        }

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
                    totals.set(line.product.id, (totals.get(line.product.id) || { product: line.product, qty: 0 }));
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
        }
    };
    Registries.Model.extend(PosGlobalState, PrsqPosGlobalState);

    const PrsqOrder = (Order) => class PrsqOrder extends Order {
        add_product(product, options) {
            options = options || {};
            const pos = this.pos;
            if (!options.prsq_bypass && pos.prsqMustCheck && pos.prsqMustCheck(product)) {
                const requested = options.quantity !== undefined ? parseFloat(options.quantity) : 1;
                if (requested > 0) {
                    const { allowed, available } = pos.prsqCheckAvailability(product, requested);
                    if (!allowed) {
                        pos.prsqNotifyShortage(product, available, requested, () => {
                            this.add_product(product, Object.assign({}, options, { prsq_bypass: true }));
                        });
                        return;
                    }
                }
            }
            if (options.prsq_bypass && pos.unwatched) {
                // The cashier explicitly overrode the warning: do not ask again
                // while the line is created / merged.
                pos.unwatched.prsqBypassAll = true;
                try {
                    return super.add_product(product, options);
                } finally {
                    pos.unwatched.prsqBypassAll = false;
                }
            }
            return super.add_product(product, options);
        }
    };
    Registries.Model.extend(Order, PrsqOrder);

    const PrsqOrderline = (Orderline) => class PrsqOrderline extends Orderline {
        set_quantity(quantity, keep_price) {
            if (this._prsqShouldCheckQuantity(quantity, keep_price)) {
                let newQty;
                try {
                    newQty = typeof quantity === 'number' ? quantity : field_utils.parse.float('' + (quantity ? quantity : 0));
                } catch (_error) {
                    newQty = NaN;
                }
                if (newQty > 0 && newQty > this.get_quantity()) {
                    const { allowed, available } = this.pos.prsqCheckAvailability(this.product, newQty, { line: this });
                    if (!allowed) {
                        this.pos.prsqNotifyShortage(this.product, available, newQty, () => {
                            this.prsqBypass = true;
                            try {
                                this.set_quantity(quantity, keep_price);
                            } finally {
                                this.prsqBypass = false;
                            }
                        });
                        return false;
                    }
                }
            }
            return super.set_quantity(...arguments);
        }

        _prsqShouldCheckQuantity(quantity, keep_price) {
            if (this.prsqBypass || quantity === 'remove' || keep_price === 'do not recompute unit price') {
                return false;
            }
            if (!this.pos || !this.pos.prsqMustCheck || !this.order || !this.product) {
                return false;
            }
            if (this.pos.unwatched && this.pos.unwatched.prsqBypassAll) {
                return false;
            }
            if (!this.pos.prsqMustCheck(this.product)) {
                return false;
            }
            // Lines under construction are checked by Order.add_product.
            return this.order.get_orderlines().some((line) => line.id === this.id);
        }
    };
    Registries.Model.extend(Orderline, PrsqOrderline);

    return { PrsqPosGlobalState, PrsqOrder, PrsqOrderline };
});
