odoo.define('pos_restrict_stock_quantity.ProductScreen', function (require) {
    'use strict';

    const ProductScreen = require('point_of_sale.ProductScreen');
    const Registries = require('point_of_sale.Registries');

    const PrsqProductScreen = (ProductScreen) => class PrsqProductScreen extends ProductScreen {
        /**
         * In "block" mode, refuse out-of-stock products before asking for
         * lots, attributes or weight. Order.add_product remains the single
         * source of truth for every other path (barcode, merge...).
         */
        async _clickProduct(event) {
            const pos = this.env.pos;
            const product = event.detail.product || event.detail;
            if (pos.prsqMustCheck(product) && pos.prsqSettings.mode === 'block') {
                const requested = event.detail.quantity !== undefined ? parseFloat(event.detail.quantity) : 1;
                const { allowed, available } = pos.prsqCheckAvailability(product, requested > 0 ? requested : 1);
                if (!allowed) {
                    await pos.prsqNotifyShortage(product, available, requested > 0 ? requested : 1);
                    return;
                }
            }
            return super._clickProduct(...arguments);
        }
    };

    Registries.Component.extend(ProductScreen, PrsqProductScreen);

    return PrsqProductScreen;
});
