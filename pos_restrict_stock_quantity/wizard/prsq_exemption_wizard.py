# -*- coding: utf-8 -*-
from odoo import _, api, fields, models
from odoo.osv import expression


class PrsqExemptionWizard(models.TransientModel):
    _name = 'prsq.exemption.wizard'
    _description = 'POS Stock Restriction - Product Exemptions'

    config_id = fields.Many2one('pos.config', string='Point of Sale', required=True, ondelete='cascade')
    company_id = fields.Many2one(related='config_id.company_id')
    stock_location_id = fields.Many2one(related='config_id.prsq_stock_location_id')

    # Filters
    search_text = fields.Char(string='Name / Reference / Barcode')
    categ_ids = fields.Many2many(
        'product.category', 'prsq_exemption_wizard_categ_rel', 'wizard_id', 'categ_id',
        string='Product Categories', help='Child categories are included.')
    pos_categ_ids = fields.Many2many(
        'pos.category', 'prsq_exemption_wizard_pos_categ_rel', 'wizard_id', 'pos_categ_id',
        string='POS Categories', help='Child categories are included.')
    tag_ids = fields.Many2many(
        'product.tag', 'prsq_exemption_wizard_tag_rel', 'wizard_id', 'tag_id',
        string='Product Tags')
    available_in_pos_only = fields.Boolean(string='Available in POS only', default=True)
    stock_state = fields.Selection(
        [('all', 'Any Stock Level'),
         ('out', 'Out of Stock (<= 0)'),
         ('negative', 'Negative Stock (< 0)'),
         ('available', 'In Stock (> 0)')],
        string='Stock Level', default='all', required=True)
    exemption_state = fields.Selection(
        [('all', 'All Products'),
         ('not_exempt', 'Not Exempted'),
         ('exempt', 'Already Exempted')],
        string='Exemption Status', default='not_exempt', required=True)
    limit = fields.Integer(string='Max Lines Displayed', default=200)

    # Results
    line_ids = fields.One2many('prsq.exemption.wizard.line', 'wizard_id', string='Products')
    result_count = fields.Integer(string='Matching Products', readonly=True)
    selected_count = fields.Integer(compute='_compute_counts')
    exempt_count = fields.Integer(related='config_id.prsq_exempt_count')
    searched = fields.Boolean(readonly=True)

    @api.depends('line_ids.selected')
    def _compute_counts(self):
        for wizard in self:
            wizard.selected_count = len(wizard.line_ids.filtered('selected'))

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------
    def _get_product_domain(self):
        self.ensure_one()
        domain = [
            ('is_storable', '=', True),
            ('company_id', 'in', (self.config_id.company_id.id, False)),
        ]
        if self.available_in_pos_only:
            domain.append(('available_in_pos', '=', True))
        if self.search_text:
            text = self.search_text.strip()
            domain = expression.AND([domain, [
                '|', '|', ('name', 'ilike', text), ('default_code', 'ilike', text),
                ('barcode', 'ilike', text)]])
        if self.categ_ids:
            domain.append(('categ_id', 'child_of', self.categ_ids.ids))
        if self.pos_categ_ids:
            domain.append(('pos_categ_ids', 'child_of', self.pos_categ_ids.ids))
        if self.tag_ids:
            domain.append(('product_tag_ids', 'in', self.tag_ids.ids))
        exempt_ids = self.config_id.prsq_exempt_product_ids.ids
        if self.exemption_state == 'exempt':
            domain.append(('id', 'in', exempt_ids))
        elif self.exemption_state == 'not_exempt' and exempt_ids:
            domain.append(('id', 'not in', exempt_ids))
        return domain

    def _get_matching_products(self):
        """Return (products, stock_map) matching every filter, stock included."""
        self.ensure_one()
        products = self.env['product.product'].search(
            self._get_product_domain(), order='default_code, name, id')
        stock_map = self.config_id._prsq_compute_stock_map(products.ids)
        if self.stock_state != 'all':
            check = {
                'out': lambda qty: qty <= 0,
                'negative': lambda qty: qty < 0,
                'available': lambda qty: qty > 0,
            }[self.stock_state]
            products = products.filtered(lambda p: check(stock_map.get(p.id, [0.0])[0]))
        return products, stock_map

    def _reopen(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Stock Restriction Exemptions'),
            'res_model': self._name,
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
            'context': dict(self.env.context, prsq_wizard=True),
        }

    def action_search(self):
        self.ensure_one()
        products, stock_map = self._get_matching_products()
        exempt_ids = set(self.config_id.prsq_exempt_product_ids.ids)
        limit = self.limit if self.limit > 0 else len(products)
        commands = [(5, 0, 0)]
        for product in products[:limit]:
            on_hand, forecast = stock_map.get(product.id, [0.0, 0.0])
            commands.append((0, 0, {
                'product_id': product.id,
                'on_hand': on_hand,
                'forecast': forecast,
                'is_exempt': product.id in exempt_ids,
            }))
        self.write({'line_ids': commands, 'result_count': len(products), 'searched': True})
        return self._reopen()

    def action_reset_filters(self):
        self.write({
            'search_text': False,
            'categ_ids': [(5, 0, 0)],
            'pos_categ_ids': [(5, 0, 0)],
            'tag_ids': [(5, 0, 0)],
            'available_in_pos_only': True,
            'stock_state': 'all',
            'exemption_state': 'not_exempt',
            'line_ids': [(5, 0, 0)],
            'result_count': 0,
            'searched': False,
        })
        return self._reopen()

    # ------------------------------------------------------------------
    # Selection helpers
    # ------------------------------------------------------------------
    def action_select_all(self):
        self.line_ids.write({'selected': True})
        return self._reopen()

    def action_deselect_all(self):
        self.line_ids.write({'selected': False})
        return self._reopen()

    def action_invert_selection(self):
        for line in self.line_ids:
            line.selected = not line.selected
        return self._reopen()

    # ------------------------------------------------------------------
    # Bulk updates
    # ------------------------------------------------------------------
    def _apply(self, products, exempt):
        self.ensure_one()
        if products:
            command = 4 if exempt else 3
            self.config_id.write({
                'prsq_exempt_product_ids': [(command, product.id) for product in products],
            })
            lines = self.line_ids.filtered(lambda l: l.product_id in products)
            lines.write({'is_exempt': exempt, 'selected': False})
        return self._reopen()

    def action_exempt_selected(self):
        return self._apply(self.line_ids.filtered('selected').product_id, True)

    def action_unexempt_selected(self):
        return self._apply(self.line_ids.filtered('selected').product_id, False)

    def action_exempt_all_matching(self):
        products, _stock = self._get_matching_products()
        return self._apply(products, True)

    def action_unexempt_all_matching(self):
        products, _stock = self._get_matching_products()
        return self._apply(products, False)

    def action_clear_all_exemptions(self):
        self.ensure_one()
        self.config_id.prsq_exempt_product_ids = [(5, 0, 0)]
        self.line_ids.write({'is_exempt': False})
        return self._reopen()


class PrsqExemptionWizardLine(models.TransientModel):
    _name = 'prsq.exemption.wizard.line'
    _description = 'POS Stock Restriction - Exemption Candidate'
    _order = 'id'

    wizard_id = fields.Many2one('prsq.exemption.wizard', required=True, ondelete='cascade')
    selected = fields.Boolean(string='Select')
    product_id = fields.Many2one('product.product', string='Product', required=True, readonly=True)
    default_code = fields.Char(related='product_id.default_code', string='Internal Reference')
    categ_id = fields.Many2one(related='product_id.categ_id', string='Product Category')
    uom_id = fields.Many2one(related='product_id.uom_id', string='Unit of Measure')
    on_hand = fields.Float(string='On Hand', digits='Product Unit of Measure', readonly=True)
    forecast = fields.Float(string='Forecasted', digits='Product Unit of Measure', readonly=True)
    is_exempt = fields.Boolean(string='Exempted', readonly=True)
