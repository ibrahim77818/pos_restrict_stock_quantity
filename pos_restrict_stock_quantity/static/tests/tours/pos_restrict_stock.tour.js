/** @odoo-module */

import { registry } from "@web/core/registry";
import * as ProductScreen from "@point_of_sale/../tests/tours/helpers/ProductScreenTourMethods";
import * as PaymentScreen from "@point_of_sale/../tests/tours/helpers/PaymentScreenTourMethods";
import * as ReceiptScreen from "@point_of_sale/../tests/tours/helpers/ReceiptScreenTourMethods";

const card = (name) => `article.product:has(.product-name:contains("${name}"))`;
const check = (content, trigger) => ({ content, trigger, isCheck: true });

const Prsq = {
    closeErrorPopup: () => ({ content: "close error popup", trigger: ".popup-error .footer .cancel" }),
    confirmPopup: () => ({ content: "confirm popup", trigger: ".popup-confirm .footer .confirm" }),
    cancelPopup: () => ({ content: "cancel popup", trigger: ".popup-confirm .footer .cancel" }),
    clickRefreshStock: () => ({
        content: "click refresh stock",
        trigger: ".control-button.prsq-refresh-button",
    }),
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
    errorPopupShown: () =>
        check("stock error popup is shown", ".modal-dialog .popup-error .title:contains('Stock')"),
    confirmPopupShown: () =>
        check(
            "stock warning popup is shown",
            ".modal-dialog .popup-confirm .title:contains('Insufficient Stock')"
        ),
    noPopup: () => check("no popup is open", "body:not(:has(.modal-dialog .popup))"),
    orderHasNo: (name) =>
        check(
            `order has no '${name}' line`,
            `.pos:not(:has(.orderline .product-name:contains("${name}")))`
        ),
};

registry.category("web_tour.tours").add("PosRestrictStockBlockTour", {
    test: true,
    url: "/pos/ui",
    steps: () =>
        [
            ProductScreen.confirmOpeningPopup(),
            ProductScreen.clickHomeCategory(),

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
            ProductScreen.selectedOrderlineHas("PRSQ Apple", "1.0"),
            Prsq.onHandBadgeIs("PRSQ Apple", "1", "in"),
            ProductScreen.clickDisplayedProduct("PRSQ Apple"),
            ProductScreen.selectedOrderlineHas("PRSQ Apple", "2.0"),
            Prsq.onHandBadgeIs("PRSQ Apple", "0", "out"),
            Prsq.isBlocked("PRSQ Apple"),
            ProductScreen.clickDisplayedProduct("PRSQ Apple"),
            Prsq.errorPopupShown(),
            Prsq.closeErrorPopup(),
            Prsq.noPopup(),
            ProductScreen.selectedOrderlineHas("PRSQ Apple", "2.0"),

            // 3. Quantity increase from the numpad is refused as well
            ProductScreen.pressNumpad("5"),
            Prsq.errorPopupShown(),
            Prsq.closeErrorPopup(),
            ProductScreen.selectedOrderlineHas("PRSQ Apple", "2.0"),

            // 4. Out of stock product cannot be added
            ProductScreen.clickDisplayedProduct("PRSQ Banana"),
            Prsq.errorPopupShown(),
            Prsq.closeErrorPopup(),
            Prsq.orderHasNo("PRSQ Banana"),

            // 5. Exempted product and consumable are always sold
            ProductScreen.clickDisplayedProduct("PRSQ Cherry"),
            Prsq.noPopup(),
            ProductScreen.selectedOrderlineHas("PRSQ Cherry", "1.0"),
            Prsq.onHandBadgeIs("PRSQ Cherry", "-1", "out"),
            ProductScreen.clickDisplayedProduct("PRSQ Water"),
            Prsq.noPopup(),
            ProductScreen.selectedOrderlineHas("PRSQ Water", "1.0"),

            // 6. Pay; after sync the server quantities are reloaded
            ProductScreen.clickPayButton(),
            PaymentScreen.clickPaymentMethod("Bank"),
            PaymentScreen.clickValidate(),
            ReceiptScreen.isShown(),
            ReceiptScreen.clickNextOrder(),
            Prsq.onHandBadgeIs("PRSQ Apple", "0", "out"),
            Prsq.clickRefreshStock(),
            Prsq.onHandBadgeIs("PRSQ Apple", "0", "out"),
            Prsq.onHandBadgeIs("PRSQ Cherry", "-1", "out"),
            ProductScreen.clickDisplayedProduct("PRSQ Apple"),
            Prsq.errorPopupShown(),
            Prsq.closeErrorPopup(),
            ProductScreen.orderIsEmpty(),
        ].flat(),
});

registry.category("web_tour.tours").add("PosRestrictStockWarnTour", {
    test: true,
    url: "/pos/ui",
    steps: () =>
        [
            ProductScreen.confirmOpeningPopup(),
            ProductScreen.clickHomeCategory(),

            // Cancelling the warning does not add the product
            ProductScreen.clickDisplayedProduct("PRSQ Banana"),
            Prsq.confirmPopupShown(),
            Prsq.cancelPopup(),
            Prsq.orderHasNo("PRSQ Banana"),

            // Confirming the warning sells it anyway (override)
            ProductScreen.clickDisplayedProduct("PRSQ Banana"),
            Prsq.confirmPopupShown(),
            Prsq.confirmPopup(),
            ProductScreen.selectedOrderlineHas("PRSQ Banana", "1.0"),
            Prsq.onHandBadgeIs("PRSQ Banana", "-1", "out"),

            // In stock products are not affected
            ProductScreen.clickDisplayedProduct("PRSQ Apple"),
            Prsq.noPopup(),
            ProductScreen.selectedOrderlineHas("PRSQ Apple", "1.0"),
        ].flat(),
});
