# -*- coding: utf-8 -*-
from odoo.tests import tagged

from odoo.addons.point_of_sale.tests.test_frontend import TestPointOfSaleHttpCommon


@tagged('post_install', '-at_install', 'pos_restrict_stock_quantity')
class TestPrsqUi(TestPointOfSaleHttpCommon):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        config = cls.main_pos_config
        location = config.picking_type_id.default_location_src_id

        def product(name, storable=True):
            return env['product.product'].create({
                'name': name,
                'is_storable': storable,
                'available_in_pos': True,
                'list_price': 10.0,
                'taxes_id': [(5, 0, 0)],
            })

        cls.apple = product('PRSQ Apple')      # 2 in stock
        cls.banana = product('PRSQ Banana')    # out of stock, 5 incoming
        cls.cherry = product('PRSQ Cherry')    # out of stock, exempted
        cls.water = product('PRSQ Water', storable=False)
        env['stock.quant']._update_available_quantity(cls.apple, location, 2)
        move = env['stock.move'].create({
            'product_id': cls.banana.id,
            'product_uom': cls.banana.uom_id.id,
            'product_uom_qty': 5,
            'location_id': env.ref('stock.stock_location_suppliers').id,
            'location_dest_id': location.id,
        })
        move._action_confirm()

        # Template with two variants: Small (3 in stock) and Large (none)
        size = env['product.attribute'].create({
            'name': 'PRSQ Size',
            'display_type': 'radio',
            'create_variant': 'always',
            'value_ids': [(0, 0, {'name': 'Small'}), (0, 0, {'name': 'Large'})],
        })
        cls.shirt_tmpl = env['product.template'].create({
            'name': 'PRSQ Shirt',
            'is_storable': True,
            'available_in_pos': True,
            'list_price': 10.0,
            'taxes_id': [(5, 0, 0)],
            'attribute_line_ids': [(0, 0, {
                'attribute_id': size.id,
                'value_ids': [(6, 0, size.value_ids.ids)],
            })],
        })
        cls.shirt_small = cls.shirt_tmpl.product_variant_ids.filtered(
            lambda p: p.product_template_attribute_value_ids.name == 'Small')
        env['stock.quant']._update_available_quantity(cls.shirt_small, location, 3)

        config.write({
            'prsq_show_stock': True,
            'prsq_show_forecast': True,
            'prsq_restrict_out_of_stock': True,
            'prsq_restriction_basis': 'on_hand',
            'prsq_exempt_product_ids': [(6, 0, cls.cherry.ids)],
            'prsq_refresh_interval': 0,
        })

    def test_01_block_mode_tour(self):
        self.main_pos_config.prsq_restriction_mode = 'block'
        self.main_pos_config.with_user(self.pos_user).open_ui()
        self.start_tour('/pos/ui?config_id=%d' % self.main_pos_config.id,
                        'PosRestrictStockBlockTour', login='pos_user')
        order = self.env['pos.order'].search([('session_id', '=', self.main_pos_config.current_session_id.id)])
        self.assertEqual(len(order), 1)
        quantities = {line.product_id: line.qty for line in order.lines}
        self.assertEqual(quantities[self.apple], 2.0)
        self.assertEqual(quantities[self.cherry], 1.0)
        self.assertNotIn(self.banana, quantities)

    def test_02_warn_mode_tour(self):
        self.main_pos_config.prsq_restriction_mode = 'warn'
        self.main_pos_config.with_user(self.pos_user).open_ui()
        self.start_tour('/pos/ui?config_id=%d' % self.main_pos_config.id,
                        'PosRestrictStockWarnTour', login='pos_user')

    def test_03_variant_tour(self):
        """Cards show templates in Odoo 19; the chosen variant is checked."""
        self.main_pos_config.prsq_restriction_mode = 'block'
        self.main_pos_config.with_user(self.pos_user).open_ui()
        self.start_tour('/pos/ui?config_id=%d' % self.main_pos_config.id,
                        'PosRestrictStockVariantTour', login='pos_user')
