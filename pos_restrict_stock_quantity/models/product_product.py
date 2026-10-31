# -*- coding: utf-8 -*-
from odoo import api, models


class ProductProduct(models.Model):
    _inherit = 'product.product'

    @api.model
    def _load_pos_data_search_read(self, data, config):
        """Embed the stock map of every product variant sent to the POS.

        Odoo 19 keeps keys starting with ``_`` on the frontend records, so the
        map travels on the ``pos.config`` record (``_prsq_stock_map``) and no
        RPC is needed while the cashier adds products. Odoo 19 only re-sends
        products modified since the last load (the others come from the local
        cache): the POS fetches the missing quantities once, in background.
        """
        result = super()._load_pos_data_search_read(data, config)
        config_data = data.get('pos.config') or []
        if config_data and config:
            config_sudo = config.sudo()
            if config_sudo._prsq_is_active():
                product_ids = [product['id'] for product in result]
                config_data[0]['_prsq_stock_map'] = config_sudo._prsq_frontend_stock_map(product_ids)
        return result
