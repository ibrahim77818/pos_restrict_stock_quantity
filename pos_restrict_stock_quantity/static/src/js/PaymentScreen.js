odoo.define('pos_restrict_stock_quantity.PaymentScreen', function (require) {
    'use strict';

    const PaymentScreen = require('point_of_sale.PaymentScreen');
    const Registries = require('point_of_sale.Registries');

    const PrsqPaymentScreen = (PaymentScreen) => class PrsqPaymentScreen extends PaymentScreen {
        /**
         * Last safety net before the order is validated: quantities may have
         * changed since the lines were added (background refresh, other
         * open orders). Only enforced in "block" mode; in "warn" mode the
         * cashier already confirmed each override.
         */
        async _isOrderValid(isForceValidate) {
            const pos = this.env.pos;
            if (pos.prsqSettings && pos.prsqSettings.restrict && pos.prsqSettings.mode === 'block') {
                const violations = pos.prsqGetOrderViolations(this.currentOrder);
                if (violations.length) {
                    const body = violations
                        .map((v) => pos.prsqShortageMessage(v.product, v.available, v.requested))
                        .join('\n');
                    await this.showPopup('ErrorPopup', {
                        title: this.env._t('Insufficient Stock'),
                        body: body + '\n' + this.env._t('Please adjust the quantities before validating the order.'),
                    });
                    return false;
                }
            }
            return super._isOrderValid(...arguments);
        }
    };

    Registries.Component.extend(PaymentScreen, PrsqPaymentScreen);

    return PrsqPaymentScreen;
});
