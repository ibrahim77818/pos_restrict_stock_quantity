# -*- coding: utf-8 -*-
from odoo import _, api, fields, models
from odoo.exceptions import ValidationError
from odoo.tools import float_round, split_every

# Products are processed by batches so that very large catalogues never
# produce gigantic IN (...) clauses.
STOCK_BATCH_SIZE = 5000


class PosConfig(models.Model):
    _inherit = 'pos.config'

    # ------------------------------------------------------------------
    # Display
    # ------------------------------------------------------------------
    prsq_show_stock = fields.Boolean(
        string='Show Stock on Products', default=True,
        help='Display a green (in stock) or red (out of stock) on-hand '
             'quantity badge on every storable product card.')
    prsq_show_forecast = fields.Boolean(
        string='Show Forecasted Quantity',
        help='Also display a blue badge with the forecasted (virtual) quantity.')

    # ------------------------------------------------------------------
    # Restriction
    # ------------------------------------------------------------------
    prsq_restrict_out_of_stock = fields.Boolean(
        string='Restrict Out-of-Stock Sales',
        help='Prevent cashiers from selling more than the available quantity '
             'of storable products.')
    prsq_restriction_basis = fields.Selection(
        [('on_hand', 'On Hand Quantity'), ('forecast', 'Forecasted Quantity')],
        string='Available Quantity Based On', default='on_hand', required=True)
    prsq_restriction_mode = fields.Selection(
        [('block', 'Block the sale'), ('warn', 'Warn and allow override')],
        string='When Stock Is Insufficient', default='block', required=True)
    prsq_exempt_product_ids = fields.Many2many(
        'product.product', 'pos_config_prsq_exempt_product_rel',
        'config_id', 'product_id', string='Exempted Products',
        domain="[('is_storable', '=', True)]",
        help='These products can always be sold, whatever their stock level.')
    prsq_exempt_count = fields.Integer(
        string='Exempted Products Count', compute='_compute_prsq_exempt_count')

    # ------------------------------------------------------------------
    # Stock source mapping
    # ------------------------------------------------------------------
    prsq_location_scope = fields.Selection(
        [('picking_type', 'Operation Type Source Location'),
         ('warehouse', 'Whole Warehouse'),
         ('location', 'Specific Location')],
        string='Compute Stock From', default='picking_type', required=True,
        help='Operation Type Source Location: the default source location of '
             'the POS Operation Type (and its children).\n'
             'Whole Warehouse: every internal location of the warehouse.\n'
             'Specific Location: a location you choose (and its children).')
    prsq_warehouse_id = fields.Many2one(
        'stock.warehouse', string='Stock Warehouse',
        compute='_compute_prsq_warehouse_id', store=True, readonly=False,
        help='Defaults to the warehouse of the POS Operation Type.')
    prsq_location_id = fields.Many2one(
        'stock.location', string='Stock Location',
        domain="[('usage', 'in', ('internal', 'view')), "
               "('company_id', 'in', (company_id, False))]")
    prsq_stock_location_id = fields.Many2one(
        'stock.location', string='Effective Stock Location',
        compute='_compute_prsq_stock_location_id',
        help='Location (with its children) used to compute POS quantities.')
    prsq_refresh_interval = fields.Integer(
        string='Auto Refresh (minutes)', default=5,
        help='Reload stock quantities in the background every N minutes '
             'while the POS is open. 0 disables the periodic refresh '
             '(quantities are still refreshed after each synced order).')

    # ------------------------------------------------------------------
    # Computes & constraints
    # ------------------------------------------------------------------
    @api.depends('prsq_exempt_product_ids')
    def _compute_prsq_exempt_count(self):
        for config in self:
            config.prsq_exempt_count = len(config.prsq_exempt_product_ids)

    @api.depends('picking_type_id')
    def _compute_prsq_warehouse_id(self):
        for config in self:
            if config.picking_type_id.warehouse_id:
                config.prsq_warehouse_id = config.picking_type_id.warehouse_id
            elif not config.prsq_warehouse_id:
                config.prsq_warehouse_id = config.warehouse_id

    @api.depends('prsq_location_scope', 'prsq_warehouse_id', 'prsq_location_id',
                 'picking_type_id.default_location_src_id')
    def _compute_prsq_stock_location_id(self):
        for config in self:
            config.prsq_stock_location_id = config._prsq_get_stock_location()

    @api.constrains('prsq_location_scope', 'prsq_location_id', 'prsq_warehouse_id')
    def _check_prsq_location_scope(self):
        for config in self:
            if config.prsq_location_scope == 'location' and not config.prsq_location_id:
                raise ValidationError(_(
                    'Please select the stock location used by the Point of Sale "%s".',
                    config.name))
            if config.prsq_location_scope == 'warehouse' and not config.prsq_warehouse_id:
                raise ValidationError(_(
                    'Please select the warehouse used by the Point of Sale "%s".',
                    config.name))

    @api.constrains('prsq_refresh_interval')
    def _check_prsq_refresh_interval(self):
        if any(config.prsq_refresh_interval < 0 for config in self):
            raise ValidationError(_('The stock auto refresh interval cannot be negative.'))

    # ------------------------------------------------------------------
    # Stock engine
    # ------------------------------------------------------------------
    def _prsq_is_active(self):
        """Stock data is only computed when something consumes it."""
        self.ensure_one()
        return self.prsq_show_stock or self.prsq_show_forecast or self.prsq_restrict_out_of_stock

    def _prsq_get_stock_location(self):
        """Return the root location whose children are used for quantities."""
        self.ensure_one()
        if self.prsq_location_scope == 'location':
            return self.prsq_location_id
        if self.prsq_location_scope == 'warehouse':
            return self.prsq_warehouse_id.view_location_id
        location = self.picking_type_id.default_location_src_id
        if not location:
            warehouse = self.picking_type_id.warehouse_id or self.prsq_warehouse_id or self.warehouse_id
            location = warehouse.lot_stock_id
        return location

    def _prsq_stock_context(self):
        self.ensure_one()
        if self.prsq_location_scope == 'warehouse' and self.prsq_warehouse_id:
            return {'warehouse': self.prsq_warehouse_id.id}
        location = self._prsq_get_stock_location()
        return {'location': location.id} if location else {}

    def _prsq_get_pending_quantities(self, product_ids):
        """Quantities sold in still-open sessions whose stock moves are only
        generated at session closing (``update_stock_at_closing``).

        Without this correction the on-hand quantity would not decrease until
        the session is closed, and the restriction could be bypassed by
        selling the same unit on several terminals.
        """
        self.ensure_one()
        location = self._prsq_get_stock_location()
        if not location or not product_ids:
            return {}
        domain = [
            ('product_id', 'in', product_ids),
            ('order_id.state', 'in', ('paid', 'done', 'invoiced')),
            ('order_id.session_id.state', '!=', 'closed'),
            ('order_id.session_id.update_stock_at_closing', '=', True),
            ('order_id.picking_ids', '=', False),
            ('order_id.config_id.picking_type_id.default_location_src_id', 'child_of', location.id),
        ]
        groups = self.env['pos.order.line'].sudo()._read_group(
            domain, ['product_id'], ['qty:sum'])
        return {product.id: qty for product, qty in groups}

    def _prsq_compute_stock_map(self, product_ids):
        """Return ``{product_id: [on_hand, forecasted]}`` for the storable
        products among ``product_ids``, computed for this POS location.

        Consumables and services are not tracked, hence absent from the map.
        """
        self.ensure_one()
        if not product_ids:
            return {}
        Product = self.env['product.product'].sudo().with_company(self.company_id).with_context(
            active_test=False, **self._prsq_stock_context())
        digits = self.env['decimal.precision'].precision_get('Product Unit of Measure')
        result = {}
        for batch in split_every(STOCK_BATCH_SIZE, list(product_ids)):
            storable = Product.search([('id', 'in', list(batch)), ('is_storable', '=', True)])
            if not storable:
                continue
            quantities = storable._compute_quantities_dict(None, None, None)
            pending = self._prsq_get_pending_quantities(storable.ids)
            for product_id, qty in quantities.items():
                sold = pending.get(product_id, 0.0)
                result[product_id] = [
                    float_round(qty['qty_available'] - sold, precision_digits=digits),
                    float_round(qty['virtual_available'] - sold, precision_digits=digits),
                ]
        return result

    def _prsq_frontend_stock_map(self, product_ids):
        """JSON friendly map for the POS: ``{"id": [on_hand, forecast]}`` for
        storable products and ``{"id": False}`` for untracked ones, so the
        POS never asks twice for a consumable."""
        self.ensure_one()
        stock_map = self._prsq_compute_stock_map(product_ids)
        return {str(pid): stock_map.get(pid, False) for pid in product_ids}

    @api.model
    def _load_pos_data_read(self, records, config):
        result = super()._load_pos_data_read(records, config)
        for config_vals in result:
            config_vals['_prsq_settings'] = self.browse(config_vals['id']).sudo()._prsq_get_frontend_settings()
        return result

    def _prsq_get_frontend_settings(self):
        """Settings shipped once in the POS payload."""
        self.ensure_one()
        location = self.prsq_stock_location_id
        return {
            'active': self._prsq_is_active(),
            'show_stock': self.prsq_show_stock,
            'show_forecast': self.prsq_show_forecast,
            'restrict': self.prsq_restrict_out_of_stock,
            'basis': self.prsq_restriction_basis,
            'mode': self.prsq_restriction_mode,
            'exempt_product_ids': self.prsq_exempt_product_ids.ids,
            'refresh_interval': self.prsq_refresh_interval,
            'location_name': location.display_name if location else '',
        }

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------
    def action_prsq_open_exemption_wizard(self):
        self.ensure_one()
        wizard = self.env['prsq.exemption.wizard'].create({'config_id': self.id})
        return wizard._reopen()

    def action_prsq_view_exempted_products(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Exempted Products - %s', self.name),
            'res_model': 'product.product',
            'view_mode': 'tree,form',
            'domain': [('id', 'in', self.prsq_exempt_product_ids.ids)],
            'context': {'create': False},
        }
