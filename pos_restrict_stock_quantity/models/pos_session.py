# -*- coding: utf-8 -*-
from odoo import fields, models


class PosSession(models.Model):
    _inherit = 'pos.session'

    def prsq_get_stock_map(self, product_ids):
        """Refresh endpoint used by the POS in the background.

        :param product_ids: list of product ids to refresh
        :return: dict with the stock map (string keys, JSON friendly).
                 Storable products map to ``[on_hand, forecast]``, the
                 others (consumables, services, combos) to ``False``.
        """
        self.ensure_one()
        # Cashiers may lack inventory rights: stock is read with sudo,
        # restricted to this POS location and company.
        config = self.config_id.sudo()
        if not config._prsq_is_active():
            return {'stock': {}, 'server_time': fields.Datetime.to_string(fields.Datetime.now())}
        ids = [int(pid) for pid in (product_ids or [])]
        return {
            'stock': config._prsq_frontend_stock_map(ids),
            'server_time': fields.Datetime.to_string(fields.Datetime.now()),
        }
