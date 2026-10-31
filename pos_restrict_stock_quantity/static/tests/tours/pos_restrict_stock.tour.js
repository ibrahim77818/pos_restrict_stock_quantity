odoo.define('pos_restrict_stock_quantity.tour.helpers', function (require) {
    'use strict';

    const { createTourMethods } = require('point_of_sale.tour.utils');

    const card = (name) => `.product-list .product:has(.product-name:contains("${name}"))`;

    class Do {
        closeErrorPopup() {
            return [{ content: 'close error popup', trigger: '.popup-error .footer .cancel' }];
        }
        confirmPopup() {
            return [{ content: 'confirm popup', trigger: '.popup-confirm .footer .confirm' }];
        }
        cancelPopup() {
            return [{ content: 'cancel popup', trigger: '.popup-confirm .footer .cancel' }];
        }
        clickRefreshStock() {
            return [{ content: 'click refresh stock', trigger: '.control-button.prsq-refresh-button' }];
        }
    }

    class Check {
        onHandBadgeIs(name, qty, state) {
            return [{
                content: `on-hand badge of '${name}' is ${qty} (${state})`,
                trigger: `${card(name)} .prsq-badge-onhand.prsq-${state}:contains("${qty}")`,
                run: () => {},
            }];
        }
        forecastBadgeIs(name, qty) {
            return [{
                content: `forecast badge of '${name}' is ${qty}`,
                trigger: `${card(name)} .prsq-badge-forecast:contains("${qty}")`,
                run: () => {},
            }];
        }
        hasNoBadge(name) {
            return [{
                content: `'${name}' has no stock badge`,
                trigger: `${card(name)}:not(:has(.prsq-badge))`,
                run: () => {},
            }];
        }
        isBlocked(name) {
            return [{
                content: `'${name}' is shown as out of stock`,
                trigger: `${card(name)}.prsq-blocked .prsq-ribbon`,
                run: () => {},
            }];
        }
        isNotBlocked(name) {
            return [{
                content: `'${name}' is not blocked`,
                trigger: `${card(name)}:not(.prsq-blocked)`,
                run: () => {},
            }];
        }
        isExempt(name) {
            return [{
                content: `'${name}' is exempted`,
                trigger: `${card(name)}.prsq-exempt .prsq-badge-exempt`,
                run: () => {},
            }];
        }
        errorPopupShown() {
            return [{
                content: 'stock error popup is shown',
                trigger: '.modal-dialog .popup-error .title:contains("Stock")',
                run: () => {},
            }];
        }
        confirmPopupShown() {
            return [{
                content: 'stock warning popup is shown',
                trigger: '.modal-dialog .popup-confirm .title:contains("Insufficient Stock")',
                run: () => {},
            }];
        }
        noPopup() {
            return [{
                content: 'no popup is open',
                trigger: 'body:not(:has(.modal-dialog .popup))',
                run: () => {},
            }];
        }
        orderHasNo(name) {
            return [{
                content: `order has no '${name}' line`,
                trigger: `.order:not(:has(.orderline .product-name:contains("${name}")))`,
                run: () => {},
            }];
        }
    }

    return createTourMethods('PrsqStock', Do, Check);
});

odoo.define('pos_restrict_stock_quantity.tour.block', function (require) {
    'use strict';

    const { PrsqStock } = require('pos_restrict_stock_quantity.tour.helpers');
    const { ProductScreen } = require('point_of_sale.tour.ProductScreenTourMethods');
    const { PaymentScreen } = require('point_of_sale.tour.PaymentScreenTourMethods');
    const { ReceiptScreen } = require('point_of_sale.tour.ReceiptScreenTourMethods');
    const { getSteps, startSteps } = require('point_of_sale.tour.utils');
    const Tour = require('web_tour.tour');

    startSteps();

    ProductScreen.do.confirmOpeningPopup();

    // 1. Visual indicators
    PrsqStock.check.onHandBadgeIs('PRSQ Apple', '2', 'in');
    PrsqStock.check.forecastBadgeIs('PRSQ Apple', '2');
    PrsqStock.check.onHandBadgeIs('PRSQ Banana', '0', 'out');
    PrsqStock.check.forecastBadgeIs('PRSQ Banana', '5');
    PrsqStock.check.isBlocked('PRSQ Banana');
    PrsqStock.check.onHandBadgeIs('PRSQ Cherry', '0', 'out');
    PrsqStock.check.isExempt('PRSQ Cherry');
    PrsqStock.check.isNotBlocked('PRSQ Cherry');
    PrsqStock.check.hasNoBadge('PRSQ Water');

    // 2. In stock: the badge follows the cart, the third unit is refused
    ProductScreen.do.clickDisplayedProduct('PRSQ Apple');
    ProductScreen.check.selectedOrderlineHas('PRSQ Apple', '1.00');
    PrsqStock.check.onHandBadgeIs('PRSQ Apple', '1', 'in');
    ProductScreen.do.clickDisplayedProduct('PRSQ Apple');
    ProductScreen.check.selectedOrderlineHas('PRSQ Apple', '2.00');
    PrsqStock.check.onHandBadgeIs('PRSQ Apple', '0', 'out');
    PrsqStock.check.isBlocked('PRSQ Apple');
    ProductScreen.do.clickDisplayedProduct('PRSQ Apple');
    PrsqStock.check.errorPopupShown();
    PrsqStock.do.closeErrorPopup();
    PrsqStock.check.noPopup();
    ProductScreen.check.selectedOrderlineHas('PRSQ Apple', '2.00');

    // 3. Quantity increase from the numpad is refused as well
    ProductScreen.do.pressNumpad('5');
    PrsqStock.check.errorPopupShown();
    PrsqStock.do.closeErrorPopup();
    ProductScreen.check.selectedOrderlineHas('PRSQ Apple', '2.00');

    // 4. Out of stock product cannot be added
    ProductScreen.do.clickDisplayedProduct('PRSQ Banana');
    PrsqStock.check.errorPopupShown();
    PrsqStock.do.closeErrorPopup();
    PrsqStock.check.orderHasNo('PRSQ Banana');

    // 5. Exempted product and consumable are always sold
    ProductScreen.do.clickDisplayedProduct('PRSQ Cherry');
    PrsqStock.check.noPopup();
    ProductScreen.check.selectedOrderlineHas('PRSQ Cherry', '1.00');
    PrsqStock.check.onHandBadgeIs('PRSQ Cherry', '-1', 'out');
    ProductScreen.do.clickDisplayedProduct('PRSQ Water');
    PrsqStock.check.noPopup();
    ProductScreen.check.selectedOrderlineHas('PRSQ Water', '1.00');

    // 6. Pay; after sync the server quantities are reloaded
    ProductScreen.do.clickPayButton();
    PaymentScreen.do.clickPaymentMethod('Bank');
    PaymentScreen.do.clickValidate();
    ReceiptScreen.check.isShown();
    ReceiptScreen.do.clickNextOrder();
    PrsqStock.check.onHandBadgeIs('PRSQ Apple', '0', 'out');
    PrsqStock.do.clickRefreshStock();
    PrsqStock.check.onHandBadgeIs('PRSQ Apple', '0', 'out');
    PrsqStock.check.onHandBadgeIs('PRSQ Cherry', '-1', 'out');
    ProductScreen.do.clickDisplayedProduct('PRSQ Apple');
    PrsqStock.check.errorPopupShown();
    PrsqStock.do.closeErrorPopup();
    ProductScreen.check.orderIsEmpty();

    Tour.register('PosRestrictStockBlockTour', { test: true, url: '/pos/ui' }, getSteps());
});

odoo.define('pos_restrict_stock_quantity.tour.warn', function (require) {
    'use strict';

    const { PrsqStock } = require('pos_restrict_stock_quantity.tour.helpers');
    const { ProductScreen } = require('point_of_sale.tour.ProductScreenTourMethods');
    const { getSteps, startSteps } = require('point_of_sale.tour.utils');
    const Tour = require('web_tour.tour');

    startSteps();

    ProductScreen.do.confirmOpeningPopup();

    // Cancelling the warning does not add the product
    ProductScreen.do.clickDisplayedProduct('PRSQ Banana');
    PrsqStock.check.confirmPopupShown();
    PrsqStock.do.cancelPopup();
    PrsqStock.check.orderHasNo('PRSQ Banana');

    // Confirming the warning sells it anyway (override)
    ProductScreen.do.clickDisplayedProduct('PRSQ Banana');
    PrsqStock.check.confirmPopupShown();
    PrsqStock.do.confirmPopup();
    ProductScreen.check.selectedOrderlineHas('PRSQ Banana', '1.00');
    PrsqStock.check.onHandBadgeIs('PRSQ Banana', '-1', 'out');

    // In stock products are not affected
    ProductScreen.do.clickDisplayedProduct('PRSQ Apple');
    PrsqStock.check.noPopup();
    ProductScreen.check.selectedOrderlineHas('PRSQ Apple', '1.00');

    Tour.register('PosRestrictStockWarnTour', { test: true, url: '/pos/ui' }, getSteps());
});
