# -*- coding: utf-8 -*-
from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    # All values are stored on the selected pos.config record (per terminal).
    pos_prsq_show_stock = fields.Boolean(
        related='pos_config_id.prsq_show_stock', readonly=False)
    pos_prsq_show_forecast = fields.Boolean(
        related='pos_config_id.prsq_show_forecast', readonly=False)
    pos_prsq_restrict_out_of_stock = fields.Boolean(
        related='pos_config_id.prsq_restrict_out_of_stock', readonly=False)
    pos_prsq_restriction_basis = fields.Selection(
        related='pos_config_id.prsq_restriction_basis', readonly=False)
    pos_prsq_restriction_mode = fields.Selection(
        related='pos_config_id.prsq_restriction_mode', readonly=False)
    pos_prsq_exempt_product_ids = fields.Many2many(
        related='pos_config_id.prsq_exempt_product_ids', readonly=False)
    pos_prsq_exempt_count = fields.Integer(
        related='pos_config_id.prsq_exempt_count')
    pos_prsq_location_scope = fields.Selection(
        related='pos_config_id.prsq_location_scope', readonly=False)
    pos_prsq_warehouse_id = fields.Many2one(
        related='pos_config_id.prsq_warehouse_id', readonly=False)
    pos_prsq_location_id = fields.Many2one(
        related='pos_config_id.prsq_location_id', readonly=False)
    pos_prsq_stock_location_id = fields.Many2one(
        related='pos_config_id.prsq_stock_location_id')
    pos_prsq_refresh_interval = fields.Integer(
        related='pos_config_id.prsq_refresh_interval', readonly=False)

    def action_prsq_open_exemption_wizard(self):
        self.ensure_one()
        return self.pos_config_id.action_prsq_open_exemption_wizard()
