odoo.define('pos_restrict_stock_quantity.ProductItem', function (require) {
    'use strict';

    const ProductItem = require('point_of_sale.ProductItem');
    const Registries = require('point_of_sale.Registries');

    const PrsqProductItem = (ProductItem) => class PrsqProductItem extends ProductItem {
        /**
         * Stock information of the product, or null when the product is not
         * tracked (consumable, service) or the feature is disabled.
         */
        get prsqStock() {
            const pos = this.env.pos;
            if (!pos.prsqSettings || !pos.prsqSettings.active) {
                return null;
            }
            // Reading the revision subscribes this component to stock refreshes.
            pos.prsqStockRevision; // eslint-disable-line no-unused-expressions
            return pos.prsqGetStockInfo(this.props.product);
        }
        get prsqShowOnHand() {
            return Boolean(this.env.pos.prsqSettings.show_stock);
        }
        get prsqShowForecast() {
            return Boolean(this.env.pos.prsqSettings.show_forecast);
        }
        get prsqIsOut() {
            const stock = this.prsqStock;
            return Boolean(stock && stock.onHand <= 0);
        }
        /** Restricted and nothing left to sell: dim the card. */
        get prsqIsBlocked() {
            const pos = this.env.pos;
            const stock = this.prsqStock;
            if (!stock || !pos.prsqMustCheck(this.props.product)) {
                return false;
            }
            const available = pos.prsqSettings.basis === 'forecast' ? stock.forecast : stock.onHand;
            return available <= 0;
        }
        get prsqCardClass() {
            return {
                'prsq-tracked': Boolean(this.prsqStock),
                'prsq-blocked': this.prsqIsBlocked,
                'prsq-exempt': Boolean(this.prsqStock && this.prsqStock.exempt),
                'prsq-no-image': !this.props.product.image_128,
            };
        }
        prsqFormat(qty) {
            return this.env.pos.prsqFormatQty(qty);
        }
    };

    Registries.Component.extend(ProductItem, PrsqProductItem);

    return PrsqProductItem;
});
