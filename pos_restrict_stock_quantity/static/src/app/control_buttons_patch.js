/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";

patch(ControlButtons.prototype, {
    get prsqShowRefresh() {
        return Boolean(this.pos.prsqSettings && this.pos.prsqSettings.active);
    },
    async prsqClickRefreshStock() {
        if (this.pos.prsqRefreshing) {
            return;
        }
        this.props.close && this.props.close();
        const ok = await this.pos.prsqRefreshStock();
        if (ok) {
            this.notification.add(_t("Stock quantities updated."), { type: "success" });
        } else {
            this.dialog.add(AlertDialog, {
                title: _t("Stock Refresh Failed"),
                body: _t("Stock quantities could not be refreshed. Please check your connection."),
            });
        }
    },
});
