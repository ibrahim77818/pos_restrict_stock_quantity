/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { ErrorPopup } from "@point_of_sale/app/errors/popups/error_popup";

patch(PaymentScreen.prototype, {
    /**
     * Last safety net before the order is validated: quantities may have
     * changed since the lines were added (background refresh, other
     * open orders). Only enforced in "block" mode; in "warn" mode the
     * cashier already confirmed each override.
     */
    async _isOrderValid(isForceValidate) {
        const pos = this.pos;
        if (pos.prsqSettings && pos.prsqSettings.restrict && pos.prsqSettings.mode === "block") {
            const violations = pos.prsqGetOrderViolations(this.currentOrder);
            if (violations.length) {
                const body = violations
                    .map((v) => pos.prsqShortageMessage(v.product, v.available, v.requested))
                    .join("\n");
                await this.popup.add(ErrorPopup, {
                    title: _t("Insufficient Stock"),
                    body: body + "\n" + _t("Please adjust the quantities before validating the order."),
                });
                return false;
            }
        }
        return super._isOrderValid(...arguments);
    },
});
