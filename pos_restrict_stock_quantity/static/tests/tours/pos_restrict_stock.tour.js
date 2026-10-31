/** @odoo-module */

import { registry } from "@web/core/registry";
import * as Chrome from "@point_of_sale/../tests/pos/tours/utils/chrome_util";
import * as Dialog from "@point_of_sale/../tests/generic_helpers/dialog_util";
import * as ProductScreen from "@point_of_sale/../tests/pos/tours/utils/product_screen_util";
import * as PaymentScreen from "@point_of_sale/../tests/pos/tours/utils/payment_screen_util";
import * as ReceiptScreen from "@point_of_sale/../tests/pos/tours/utils/receipt_screen_util";
import * as ProductConfigurator from "@point_of_sale/../tests/pos/tours/utils/product_configurator_util";

const card = (name) => `article.product:has(.product-name:contains("${name}"))`;
const check = (content, trigger) => ({ content, trigger });
const click = (content, trigger) => ({ content, trigger, run: "click" });

const Prsq = {
    closeDialog: () => click("close stock dialog", ".modal .modal-footer .btn-primary"),
    confirmDialog: () =>
        click("sell anyway", ".modal .modal-footer .btn-primary:contains('Sell Anyway')"),
    cancelDialog: () => click("cancel", ".modal .modal-footer .btn-secondary:contains('Cancel')"),
    openActions: () => click("open actions", ".control-buttons .more-btn"),
    clickRefreshStock: () => click("click refresh stock", ".modal .prsq-refresh-button"),
    onHandBadgeIs: (name, qty, state) =>
        check(
            `on-hand badge of '${name}' is ${qty} (${state})`,
            `${card(name)} .prsq-badge-onhand.prsq-${state}:contains("${qty}")`
        ),
    forecastBadgeIs: (name, qty) =>
        check(`forecast badge of '${name}' is ${qty}`, `${card(name)} .prsq-badge-forecast:contains("${qty}")`),
    hasNoBadge: (name) => check(`'${name}' has no stock badge`, `${card(name)}:not(:has(.prsq-badge))`),
    isBlocked: (name) => check(`'${name}' is shown as out of stock`, `${card(name)}.prsq-blocked .prsq-ribbon`),
    isNotBlocked: (name) => check(`'${name}' is not blocked`, `${card(name)}:not(.prsq-blocked)`),
    isExempt: (name) => check(`'${name}' is exempted`, `${card(name)}.prsq-exempt .prsq-badge-exempt`),
    blockDialogShown: () =>
        check("out of stock dialog is shown", ".modal .modal-header:contains('Out of Stock')"),
    warnDialogShown: () =>
        check("stock warning dialog is shown", ".modal .modal-header:contains('Insufficient Stock')"),
    noDialog: () => check("no dialog is open", "body:not(:has(.modal))"),
    orderHasNo: (name) =>
        check(`order has no '${name}' line`, `.pos:not(:has(.orderline .product-name:contains("${name}")))`),
};

registry.category("web_tour.tours").add("PosRestrictStockBlockTour", {
    steps: () =>
        [
            Chrome.startPoS(),
            Dialog.confirm("Open Register"),

            // 1. Visual indicators
            Prsq.onHandBadgeIs("PRSQ Apple", "2", "in"),
            Prsq.forecastBadgeIs("PRSQ Apple", "2"),
            Prsq.onHandBadgeIs("PRSQ Banana", "0", "out"),
            Prsq.forecastBadgeIs("PRSQ Banana", "5"),
            Prsq.isBlocked("PRSQ Banana"),
            Prsq.onHandBadgeIs("PRSQ Cherry", "0", "out"),
            Prsq.isExempt("PRSQ Cherry"),
            Prsq.isNotBlocked("PRSQ Cherry"),
            Prsq.hasNoBadge("PRSQ Water"),

            // 2. In stock: the badge follows the cart, the third unit is refused
            ProductScreen.clickDisplayedProduct("PRSQ Apple"),
            ProductScreen.selectedOrderlineHas("PRSQ Apple", "1"),
            Prsq.onHandBadgeIs("PRSQ Apple", "1", "in"),
            ProductScreen.clickDisplayedProduct("PRSQ Apple"),
            ProductScreen.selectedOrderlineHas("PRSQ Apple", "2"),
            Prsq.onHandBadgeIs("PRSQ Apple", "0", "out"),
            Prsq.isBlocked("PRSQ Apple"),
            ProductScreen.clickDisplayedProduct("PRSQ Apple"),
            Prsq.blockDialogShown(),
            Prsq.closeDialog(),
            Prsq.noDialog(),
            ProductScreen.selectedOrderlineHas("PRSQ Apple", "2"),

            // 3. Quantity increase from the numpad is refused as well
            ProductScreen.clickNumpad("5"),
            Prsq.blockDialogShown(),
            Prsq.closeDialog(),
            ProductScreen.selectedOrderlineHas("PRSQ Apple", "2"),

            // 4. Out of stock product cannot be added
            ProductScreen.clickDisplayedProduct("PRSQ Banana"),
            Prsq.blockDialogShown(),
            Prsq.closeDialog(),
            Prsq.orderHasNo("PRSQ Banana"),

            // 5. Exempted product and consumable are always sold
            ProductScreen.clickDisplayedProduct("PRSQ Cherry"),
            Prsq.noDialog(),
            ProductScreen.selectedOrderlineHas("PRSQ Cherry", "1"),
            Prsq.onHandBadgeIs("PRSQ Cherry", "-1", "out"),
            ProductScreen.clickDisplayedProduct("PRSQ Water"),
            Prsq.noDialog(),
            ProductScreen.selectedOrderlineHas("PRSQ Water", "1"),

            // 6. Pay; after sync the server quantities are reloaded
            ProductScreen.clickPayButton(),
            PaymentScreen.clickPaymentMethod("Bank"),
            PaymentScreen.clickValidate(),
            ReceiptScreen.isShown(),
            ReceiptScreen.clickNextOrder(),
            Prsq.onHandBadgeIs("PRSQ Apple", "0", "out"),
            Prsq.openActions(),
            Prsq.clickRefreshStock(),
            Prsq.noDialog(),
            Prsq.onHandBadgeIs("PRSQ Apple", "0", "out"),
            Prsq.onHandBadgeIs("PRSQ Cherry", "-1", "out"),
            ProductScreen.clickDisplayedProduct("PRSQ Apple"),
            Prsq.blockDialogShown(),
            Prsq.closeDialog(),
            ProductScreen.orderIsEmpty(),
        ].flat(),
});

registry.category("web_tour.tours").add("PosRestrictStockWarnTour", {
    steps: () =>
        [
            Chrome.startPoS(),
            Dialog.confirm("Open Register"),

            // Cancelling the warning does not add the product
            ProductScreen.clickDisplayedProduct("PRSQ Banana"),
            Prsq.warnDialogShown(),
            Prsq.cancelDialog(),
            Prsq.orderHasNo("PRSQ Banana"),

            // Confirming the warning sells it anyway (override)
            ProductScreen.clickDisplayedProduct("PRSQ Banana"),
            Prsq.warnDialogShown(),
            Prsq.confirmDialog(),
            ProductScreen.selectedOrderlineHas("PRSQ Banana", "1"),
            Prsq.onHandBadgeIs("PRSQ Banana", "-1", "out"),

            // In stock products are not affected
            ProductScreen.clickDisplayedProduct("PRSQ Apple"),
            Prsq.noDialog(),
            ProductScreen.selectedOrderlineHas("PRSQ Apple", "1"),
        ].flat(),
});

registry.category("web_tour.tours").add("PosRestrictStockVariantTour", {
    steps: () =>
        [
            Chrome.startPoS(),
            Dialog.confirm("Open Register"),

            // Odoo 19 cards show templates: variant quantities are added up
            // (Small: 3, Large: 0) and the card stays sellable.
            Prsq.onHandBadgeIs("PRSQ Shirt", "3", "in"),
            Prsq.isNotBlocked("PRSQ Shirt"),

            // The variant chosen in the configurator is checked
            ProductScreen.clickDisplayedProduct("PRSQ Shirt"),
            ProductConfigurator.pickRadio("Large"),
            Dialog.confirm(),
            Prsq.blockDialogShown(),
            Prsq.closeDialog(),
            Prsq.orderHasNo("PRSQ Shirt"),

            ProductScreen.clickDisplayedProduct("PRSQ Shirt"),
            ProductConfigurator.pickRadio("Small"),
            Dialog.confirm(),
            Prsq.noDialog(),
            ProductScreen.selectedOrderlineHas("PRSQ Shirt", "1"),
            Prsq.onHandBadgeIs("PRSQ Shirt", "2", "in"),
        ].flat(),
});
