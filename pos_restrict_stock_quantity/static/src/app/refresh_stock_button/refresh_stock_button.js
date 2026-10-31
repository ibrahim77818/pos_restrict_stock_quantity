/** @odoo-module */

import { Component } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { useService } from "@web/core/utils/hooks";
import { usePos } from "@point_of_sale/app/store/pos_hook";
import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { ErrorPopup } from "@point_of_sale/app/errors/popups/error_popup";

export class RefreshStockButton extends Component {
    static template = "pos_restrict_stock_quantity.RefreshStockButton";

    setup() {
        this.pos = usePos();
        this.popup = useService("popup");
        this.notification = useService("pos_notification");
    }
    get isRefreshing() {
        return this.pos.prsqRefreshing;
    }
    async onClick() {
        if (this.pos.prsqRefreshing) {
            return;
        }
        const ok = await this.pos.prsqRefreshStock();
        if (ok) {
            this.notification.add(_t("Stock quantities updated."), 2000);
        } else {
            this.popup.add(ErrorPopup, {
                title: _t("Stock Refresh Failed"),
                body: _t("Stock quantities could not be refreshed. Please check your connection."),
            });
        }
    }
}

ProductScreen.addControlButton({
    component: RefreshStockButton,
    condition: function () {
        return Boolean(this.pos.prsqSettings && this.pos.prsqSettings.active);
    },
});
