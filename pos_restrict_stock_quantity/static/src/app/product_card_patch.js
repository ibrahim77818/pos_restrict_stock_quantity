/** @odoo-module */

import { ProductCard } from "@point_of_sale/app/generic_components/product_card/product_card";

// Optional stock information computed by the POS store
// (see PosStore.prsqGetCardInfo); absent for untracked products.
ProductCard.props = {
    ...ProductCard.props,
    prsqInfo: { type: Object, optional: true },
};
