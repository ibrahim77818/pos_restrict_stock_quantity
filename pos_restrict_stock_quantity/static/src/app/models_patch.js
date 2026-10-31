/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { Order, Orderline } from "@point_of_sale/app/store/models";
import { parseFloat as oParseFloat } from "@web/views/fields/parsers";

patch(Order.prototype, {
    async add_product(product, options) {
        options = options || {};
        const pos = this.pos;
        if (!options.prsq_bypass && pos.prsqMustCheck && pos.prsqMustCheck(product)) {
            const requested = options.quantity !== undefined ? parseFloat(options.quantity) : 1;
            if (requested > 0) {
                const { allowed, available } = pos.prsqCheckAvailability(product, requested);
                if (!allowed) {
                    // Not awaited: the caller (barcode, click) must not wait
                    // for the cashier to close the popup.
                    pos.prsqNotifyShortage(product, available, requested, () =>
                        this.add_product(product, { ...options, prsq_bypass: true })
                    );
                    return;
                }
            }
        }
        if (options.prsq_bypass && pos.unwatched) {
            // The cashier explicitly overrode the warning: do not ask again
            // while the line is created / merged.
            pos.unwatched.prsqBypassAll = true;
            try {
                return await super.add_product(product, options);
            } finally {
                pos.unwatched.prsqBypassAll = false;
            }
        }
        return super.add_product(product, options);
    },
});

patch(Orderline.prototype, {
    set_quantity(quantity, keep_price) {
        if (this._prsqShouldCheckQuantity(quantity)) {
            let newQty;
            try {
                newQty =
                    typeof quantity === "number"
                        ? quantity
                        : oParseFloat("" + (quantity ? quantity : 0));
            } catch {
                newQty = NaN;
            }
            if (newQty > 0 && newQty > this.get_quantity()) {
                const { allowed, available } = this.pos.prsqCheckAvailability(this.product, newQty, {
                    line: this,
                });
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
    },

    _prsqShouldCheckQuantity(quantity) {
        if (this.prsqBypass || quantity === "remove") {
            return false;
        }
        const pos = this.pos;
        if (!pos || !pos.prsqMustCheck || !this.order || !this.product) {
            return false;
        }
        if (pos.unwatched && pos.unwatched.prsqBypassAll) {
            return false;
        }
        // Lines restored from storage / server, combo children and refunds
        // are never restricted.
        if (this.comboParent || this.refunded_orderline_id) {
            return false;
        }
        if (!pos.prsqMustCheck(this.product)) {
            return false;
        }
        // Lines under construction are checked by Order.add_product.
        return this.order.get_orderlines().some((line) => line.id === this.id);
    },
});
