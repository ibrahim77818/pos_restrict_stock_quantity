# -*- coding: utf-8 -*-
from odoo import fields, models


class PosSession(models.Model):
    _inherit = 'pos.session'

    def _pos_data_process(self, loaded_data):
        super()._pos_data_process(loaded_data)
        loaded_data['prsq_settings'] = self.config_id.sudo()._prsq_get_frontend_settings()

    def _process_pos_ui_product_product(self, products):
        """Embed the stock map in the product payload.

        This hook is shared by the initial load, background loading of
        limited catalogues and on-demand product searches (barcode, search
        bar), so every product reaching the POS carries its quantities and no
        RPC is ever needed while the cashier adds products.
        ``prsq_stock`` is ``[on_hand, forecasted]`` for storable products and
        ``False`` for untracked ones.
        """
        super()._process_pos_ui_product_product(products)
        # Cashiers may lack inventory rights: stock is read with sudo,
        # restricted to this POS location and company.
        config = self.config_id.sudo()
        if not products or not config._prsq_is_active():
            return
        stock_map = config._prsq_compute_stock_map([product['id'] for product in products])
        for product in products:
            product['prsq_stock'] = stock_map.get(product['id'], False)

    def prsq_get_stock_map(self, product_ids):
        """Refresh endpoint used by the POS in the background.

        :param product_ids: list of product ids to refresh
        :return: dict with the stock map (string keys, JSON friendly)
        """
        self.ensure_one()
        config = self.config_id.sudo()
        if not config._prsq_is_active():
            return {'stock': {}, 'server_time': fields.Datetime.to_string(fields.Datetime.now())}
        ids = [int(pid) for pid in (product_ids or [])]
        stock_map = config._prsq_compute_stock_map(ids)
        return {
            'stock': {str(pid): values for pid, values in stock_map.items()},
            'server_time': fields.Datetime.to_string(fields.Datetime.now()),
        }
