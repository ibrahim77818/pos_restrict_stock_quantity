/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import OrderPaymentValidation from "@point_of_sale/app/utils/order_payment_validation";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";

patch(OrderPaymentValidation.prototype, {
    /**
     * Last safety net before the order is validated: quantities may have
     * changed since the lines were added (background refresh, other
     * open orders). Only enforced in "block" mode; in "warn" mode the
     * cashier already confirmed each override.
     */
    async isOrderValid(isForceValidate) {
        const pos = this.pos;
        if (pos.prsqSettings && pos.prsqSettings.restrict && pos.prsqSettings.mode === "block") {
            const violations = pos.prsqGetOrderViolations(this.order);
            if (violations.length) {
                const body = violations
                    .map((v) => pos.prsqShortageMessage(v.product, v.available, v.requested))
                    .join("\n");
                pos.dialog.add(AlertDialog, {
                    title: _t("Insufficient Stock"),
                    body: body + "\n" + _t("Please adjust the quantities before validating the order."),
                });
                return false;
            }
        }
        return super.isOrderValid(...arguments);
    },
});
