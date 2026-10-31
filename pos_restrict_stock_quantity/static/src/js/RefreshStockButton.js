odoo.define('pos_restrict_stock_quantity.RefreshStockButton', function (require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const ProductScreen = require('point_of_sale.ProductScreen');
    const Registries = require('point_of_sale.Registries');
    const { useListener } = require('@web/core/utils/hooks');

    class RefreshStockButton extends PosComponent {
        setup() {
            super.setup();
            useListener('click', this.onClick);
        }
        get isRefreshing() {
            return this.env.pos.prsqRefreshing;
        }
        async onClick() {
            if (this.env.pos.prsqRefreshing) {
                return;
            }
            const ok = await this.env.pos.prsqRefreshStock();
            if (ok) {
                this.showNotification(this.env._t('Stock quantities updated.'), 2000);
            } else {
                this.showPopup('ErrorPopup', {
                    title: this.env._t('Stock Refresh Failed'),
                    body: this.env._t('Stock quantities could not be refreshed. Please check your connection.'),
                });
            }
        }
    }
    RefreshStockButton.template = 'pos_restrict_stock_quantity.RefreshStockButton';

    ProductScreen.addControlButton({
        component: RefreshStockButton,
        condition: function () {
            return Boolean(this.env.pos.prsqSettings && this.env.pos.prsqSettings.active);
        },
    });

    Registries.Component.add(RefreshStockButton);

    return RefreshStockButton;
});
