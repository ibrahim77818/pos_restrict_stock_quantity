/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PosOrderline } from "@point_of_sale/app/models/pos_order_line";
import { parseFloat as oParseFloat } from "@web/views/fields/parsers";
import { prsqStoreRef } from "@pos_restrict_stock_quantity/app/pos_store_patch";

patch(PosOrderline.prototype, {
    /**
     * Odoo 19 returns `true` on success or an object {title, body} that the
     * numpad shows in an AlertDialog. "Block" mode uses that contract;
     * "warn" mode asks for confirmation and re-applies the quantity.
     */
    setQuantity(quantity, keep_price) {
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
            if (newQty > 0 && newQty > this.getQuantity()) {
                const pos = this.prsqPos;
                const product = this.product_id;
                const { allowed, available } = pos.prsqCheckAvailability(product, newQty, {
                    line: this,
                });
                if (!allowed) {
                    if (pos.prsqSettings.mode === "warn") {
                        pos.numberBuffer && pos.numberBuffer.reset();
                        pos.prsqNotifyShortage(product, available, newQty).then((override) => {
                            if (override) {
                                this.prsqBypass = true;
                                try {
                                    super.setQuantity(quantity, keep_price);
                                } finally {
                                    this.prsqBypass = false;
                                }
                            }
                        });
                        return true;
                    }
                    return pos.prsqBlockDialogProps(product, available, newQty);
                }
            }
        }
        return super.setQuantity(...arguments);
    },

    /** The POS store (reachable from any record through the env). */
    get prsqPos() {
        return prsqStoreRef.pos;
    },

    _prsqShouldCheckQuantity(quantity) {
        if (this.prsqBypass || quantity === "remove") {
            return false;
        }
        const pos = this.prsqPos;
        if (!pos || !pos.prsqMustCheck || !this.order_id || !this.product_id) {
            return false;
        }
        if (pos.unwatched && pos.unwatched.prsqBypassAll) {
            return false;
        }
        // Combo children and refunds are never restricted.
        if (this.combo_parent_id || this.refunded_orderline_id) {
            return false;
        }
        return pos.prsqMustCheck(this.product_id);
    },
});
