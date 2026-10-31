# -*- coding: utf-8 -*-
from odoo import models


class ProductProduct(models.Model):
    _inherit = 'product.product'

    def _load_pos_data(self, data):
        """Embed the stock map of every product loaded in the POS session.

        Odoo 18 keeps keys starting with ``_`` on the frontend records, so the
        map travels on the ``pos.config`` record (``_prsq_stock_map``) and no
        RPC is needed while the cashier adds products. Products loaded later
        (search, barcode, local cache) are refreshed by the POS in background.
        """
        result = super()._load_pos_data(data)
        config_data = data.get('pos.config', {}).get('data') or []
        if config_data:
            config = self.env['pos.config'].browse(config_data[0]['id']).sudo()
            if config._prsq_is_active():
                product_ids = [product['id'] for product in result['data']]
                config_data[0]['_prsq_stock_map'] = config._prsq_frontend_stock_map(product_ids)
        return result
