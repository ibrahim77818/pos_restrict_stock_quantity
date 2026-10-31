# -*- coding: utf-8 -*-
from odoo.tests import tagged

from .test_stock_map import PrsqCommon


@tagged('post_install', '-at_install', 'pos_restrict_stock_quantity')
class TestPrsqExemptionWizard(PrsqCommon):

    def setUp(self):
        super().setUp()
        self.categ_drinks = self.env['product.category'].create({'name': 'PRSQ Drinks'})
        self.categ_soda = self.env['product.category'].create(
            {'name': 'PRSQ Soda', 'parent_id': self.categ_drinks.id})
        self.categ_food = self.env['product.category'].create({'name': 'PRSQ Food'})
        self.cola = self.create_product('PRSQ Cola', self.categ_soda, 2.0)
        self.cola.default_code = 'PRSQ-COLA'
        self.juice = self.create_product('PRSQ Juice', self.categ_drinks, 3.0)
        self.water = self.create_product('PRSQ Mineral Water', self.categ_drinks, 1.0)
        self.water.barcode = '5449000000996'
        self.bread = self.create_product('PRSQ Bread', self.categ_food, 1.5)
        self.hidden = self.create_product('PRSQ Hidden Drink', self.categ_drinks, 1.0)
        self.hidden.available_in_pos = False
        self._set_qty(self.juice, self.wh_stock, 4)
        self._set_qty(self.water, self.wh_stock, -2)

    def _wizard(self, **vals):
        action = self.config.action_prsq_open_exemption_wizard()
        self.assertEqual(action['res_model'], 'prsq.exemption.wizard')
        self.assertEqual(action['target'], 'new')
        wizard = self.env['prsq.exemption.wizard'].browse(action['res_id'])
        wizard.write(vals)
        return wizard

    def test_01_category_filter_includes_children(self):
        wizard = self._wizard(categ_ids=[(6, 0, self.categ_drinks.ids)])
        wizard.action_search()
        self.assertEqual(set(wizard.line_ids.product_id.ids), {self.cola.id, self.juice.id, self.water.id})
        self.assertEqual(wizard.result_count, 3)
        juice_line = wizard.line_ids.filtered(lambda l: l.product_id == self.juice)
        self.assertEqual(juice_line.on_hand, 4.0)

    def test_02_available_in_pos_filter(self):
        wizard = self._wizard(categ_ids=[(6, 0, self.categ_drinks.ids)], available_in_pos_only=False)
        wizard.action_search()
        self.assertIn(self.hidden, wizard.line_ids.product_id)

    def test_03_text_search(self):
        for text, expected in (('cola', self.cola), ('PRSQ-COLA', self.cola), ('5449000000996', self.water)):
            wizard = self._wizard(search_text=text)
            wizard.action_search()
            self.assertEqual(wizard.line_ids.product_id, expected, text)

    def test_04_stock_level_filters(self):
        wizard = self._wizard(categ_ids=[(6, 0, self.categ_drinks.ids)], stock_state='out')
        wizard.action_search()
        self.assertEqual(set(wizard.line_ids.product_id.ids), {self.cola.id, self.water.id})
        wizard.write({'stock_state': 'negative'})
        wizard.action_search()
        self.assertEqual(wizard.line_ids.product_id, self.water)
        wizard.write({'stock_state': 'available'})
        wizard.action_search()
        self.assertEqual(wizard.line_ids.product_id, self.juice)

    def test_05_bulk_select_and_exempt(self):
        wizard = self._wizard(categ_ids=[(6, 0, self.categ_drinks.ids)])
        wizard.action_search()
        wizard.action_select_all()
        self.assertEqual(wizard.selected_count, 3)
        wizard.action_exempt_selected()
        self.assertEqual(set(self.config.prsq_exempt_product_ids.ids), {self.cola.id, self.juice.id, self.water.id})
        self.assertTrue(all(wizard.line_ids.mapped('is_exempt')))
        self.assertEqual(wizard.selected_count, 0)

        # Already exempted products are hidden by default
        wizard.action_search()
        self.assertFalse(wizard.line_ids)
        wizard.write({'exemption_state': 'exempt'})
        wizard.action_search()
        self.assertEqual(len(wizard.line_ids), 3)

        # Remove one exemption
        wizard.line_ids.filtered(lambda l: l.product_id == self.juice).selected = True
        wizard.action_unexempt_selected()
        self.assertEqual(set(self.config.prsq_exempt_product_ids.ids), {self.cola.id, self.water.id})

    def test_06_select_helpers(self):
        wizard = self._wizard(categ_ids=[(6, 0, self.categ_drinks.ids)])
        wizard.action_search()
        wizard.line_ids[0].selected = True
        wizard.action_invert_selection()
        self.assertEqual(wizard.selected_count, 2)
        wizard.action_deselect_all()
        self.assertEqual(wizard.selected_count, 0)

    def test_07_exempt_all_matching_ignores_display_limit(self):
        wizard = self._wizard(categ_ids=[(6, 0, self.categ_drinks.ids)], limit=1)
        wizard.action_search()
        self.assertEqual(len(wizard.line_ids), 1)
        self.assertEqual(wizard.result_count, 3)
        wizard.action_exempt_all_matching()
        self.assertEqual(self.config.prsq_exempt_count, 3)
        wizard.write({'exemption_state': 'all'})
        wizard.action_unexempt_all_matching()
        self.assertEqual(self.config.prsq_exempt_count, 0)

    def test_08_clear_and_reset(self):
        self.config.prsq_exempt_product_ids = [(6, 0, (self.cola | self.bread).ids)]
        wizard = self._wizard(search_text='cola', exemption_state='all')
        wizard.action_search()
        wizard.action_clear_all_exemptions()
        self.assertFalse(self.config.prsq_exempt_product_ids)
        wizard.action_reset_filters()
        self.assertFalse(wizard.search_text)
        self.assertFalse(wizard.line_ids)
        self.assertEqual(wizard.exemption_state, 'not_exempt')

    def test_09_settings_button(self):
        settings = self.env['res.config.settings'].create({'pos_config_id': self.config.id})
        action = settings.action_prsq_open_exemption_wizard()
        wizard = self.env['prsq.exemption.wizard'].browse(action['res_id'])
        self.assertEqual(wizard.config_id, self.config)

    def test_10_exemptions_are_per_pos(self):
        other = self._new_config('PRSQ Other Shop')
        wizard = self._wizard(search_text='cola')
        wizard.action_exempt_all_matching()
        self.assertEqual(self.config.prsq_exempt_product_ids, self.cola)
        self.assertFalse(other.prsq_exempt_product_ids)

    def test_11_pos_category_filter_includes_children(self):
        """v17: products carry several POS categories (pos_categ_ids)."""
        parent = self.env['pos.category'].create({'name': 'PRSQ POS Drinks'})
        child = self.env['pos.category'].create({'name': 'PRSQ POS Soda', 'parent_id': parent.id})
        self.cola.pos_categ_ids = [(6, 0, child.ids)]
        self.juice.pos_categ_ids = [(6, 0, parent.ids)]
        wizard = self._wizard(pos_categ_ids=[(6, 0, parent.ids)])
        wizard.action_search()
        self.assertEqual(set(wizard.line_ids.product_id.ids), {self.cola.id, self.juice.id})
