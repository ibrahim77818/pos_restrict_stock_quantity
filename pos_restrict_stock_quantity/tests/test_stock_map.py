# -*- coding: utf-8 -*-
from odoo.exceptions import ValidationError
from odoo.tests import Form, tagged

from odoo.addons.point_of_sale.tests.common import TestPoSCommon


class PrsqCommon(TestPoSCommon):
    """Shared fixtures: one warehouse with a sub-location of WH/Stock and an
    internal location outside WH/Stock (still inside the warehouse)."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.warehouse = cls.company_data['default_warehouse']
        cls.wh_stock = cls.warehouse.lot_stock_id
        cls.shelf = cls.env['stock.location'].create({
            'name': 'PRSQ Shelf', 'location_id': cls.wh_stock.id, 'usage': 'internal'})
        cls.backroom = cls.env['stock.location'].create({
            'name': 'PRSQ Backroom', 'location_id': cls.warehouse.view_location_id.id, 'usage': 'internal'})
        cls.supplier_location = cls.env.ref('stock.stock_location_suppliers')

    def setUp(self):
        super().setUp()
        self.config = self.basic_config
        self.config.write({
            'picking_type_id': self.warehouse.pos_type_id.id,
            'prsq_show_stock': True,
            'prsq_show_forecast': True,
            'prsq_restrict_out_of_stock': True,
            'prsq_location_scope': 'picking_type',
        })
        self.storable = self.create_product('PRSQ Storable', self.categ_basic, 10.0, 5.0)
        self.storable_2 = self.create_product('PRSQ Storable 2', self.categ_basic, 12.0, 5.0)
        self.consumable = self.create_product('PRSQ Consumable', self.categ_basic, 3.0)
        self.consumable.is_storable = False

    def _set_qty(self, product, location, qty):
        self.env['stock.quant']._update_available_quantity(product, location, qty)

    def _incoming(self, product, qty, location=None):
        move = self.env['stock.move'].create({
            'product_id': product.id,
            'product_uom': product.uom_id.id,
            'product_uom_qty': qty,
            'location_id': self.supplier_location.id,
            'location_dest_id': (location or self.wh_stock).id,
        })
        move._action_confirm()
        return move

    def _new_config(self, name):
        return self.env['pos.config'].create({
            'name': name,
            'invoice_journal_id': self.invoice_journal.id,
            'available_pricelist_ids': self.currency_pricelist.ids,
            'pricelist_id': self.currency_pricelist.id,
            'picking_type_id': self.warehouse.pos_type_id.id,
            'payment_method_ids': [(6, 0, self.bank_pm1.ids)],
        })

    def _close_session(self, session):
        cash_pm = session.payment_method_ids.filtered('is_cash_count')[:1]
        total_cash = sum(session.order_ids.payment_ids.filtered(
            lambda p: p.payment_method_id == cash_pm).mapped('amount'))
        session.post_closing_cash_details(total_cash)
        session.close_session_from_ui()


@tagged('post_install', '-at_install', 'pos_restrict_stock_quantity')
class TestPrsqStockMap(PrsqCommon):

    def test_01_storable_only(self):
        self._set_qty(self.storable, self.wh_stock, 7)
        stock = self.config._prsq_compute_stock_map(
            [self.storable.id, self.storable_2.id, self.consumable.id])
        self.assertEqual(stock[self.storable.id], [7.0, 7.0])
        self.assertEqual(stock[self.storable_2.id], [0.0, 0.0])
        self.assertNotIn(self.consumable.id, stock, 'Consumables are never tracked')

    def test_02_location_scopes(self):
        self._set_qty(self.storable, self.wh_stock, 10)
        self._set_qty(self.storable, self.shelf, 5)
        self._set_qty(self.storable, self.backroom, 7)

        # Operation type source location (WH/Stock) and its children
        self.assertEqual(self.config.prsq_stock_location_id, self.wh_stock)
        self.assertEqual(self.config._prsq_compute_stock_map([self.storable.id])[self.storable.id][0], 15.0)

        # Whole warehouse
        self.config.prsq_location_scope = 'warehouse'
        self.assertEqual(self.config.prsq_warehouse_id, self.warehouse)
        self.assertEqual(self.config.prsq_stock_location_id, self.warehouse.view_location_id)
        self.assertEqual(self.config._prsq_compute_stock_map([self.storable.id])[self.storable.id][0], 22.0)

        # Specific location
        self.config.write({'prsq_location_scope': 'location', 'prsq_location_id': self.backroom.id})
        self.assertEqual(self.config._prsq_compute_stock_map([self.storable.id])[self.storable.id][0], 7.0)

    def test_03_operation_type_mapping(self):
        """Changing the operation type of the POS changes the stock source."""
        self._set_qty(self.storable, self.wh_stock, 10)
        self._set_qty(self.storable, self.backroom, 4)
        backroom_type = self.warehouse.pos_type_id.copy({
            'name': 'PRSQ Backroom PoS Orders',
            'sequence_code': 'PRSQB',
            'default_location_src_id': self.backroom.id,
        })
        self.config.picking_type_id = backroom_type
        self.assertEqual(self.config.prsq_stock_location_id, self.backroom)
        self.assertEqual(self.config._prsq_compute_stock_map([self.storable.id])[self.storable.id], [4.0, 4.0])

    def test_04_forecast(self):
        self._set_qty(self.storable, self.wh_stock, 3)
        self._incoming(self.storable, 8)
        on_hand, forecast = self.config._prsq_compute_stock_map([self.storable.id])[self.storable.id]
        self.assertEqual(on_hand, 3.0)
        self.assertEqual(forecast, 11.0)

    def test_05_pending_quantities_closing_mode(self):
        """Orders of an open session (stock moved at closing) are deducted
        once, and not twice after the session is closed."""
        self.company.point_of_sale_update_stock_quantities = 'closing'
        self._set_qty(self.storable, self.wh_stock, 10)
        session = self.open_new_session()
        self.assertTrue(session.update_stock_at_closing)
        self.env['pos.order'].sync_from_ui([
            self.create_ui_order_data([(self.storable, 3)]),
            self.create_ui_order_data([(self.storable, 1), (self.consumable, 2)]),
        ])
        self.assertFalse(session.order_ids.picking_ids)
        self.assertEqual(self.config._prsq_compute_stock_map([self.storable.id])[self.storable.id], [6.0, 6.0])

        self._close_session(session)
        self.assertEqual(session.state, 'closed')
        self.assertEqual(self.storable.with_context(location=self.wh_stock.id).qty_available, 6.0)
        self.assertEqual(self.config._prsq_compute_stock_map([self.storable.id])[self.storable.id], [6.0, 6.0])

    def test_06_real_time_mode(self):
        self.company.point_of_sale_update_stock_quantities = 'real'
        self._set_qty(self.storable, self.wh_stock, 10)
        session = self.open_new_session()
        self.assertFalse(session.update_stock_at_closing)
        self.env['pos.order'].sync_from_ui([self.create_ui_order_data([(self.storable, 4)])])
        self.assertTrue(session.order_ids.picking_ids)
        self.assertEqual(self.config._prsq_compute_stock_map([self.storable.id])[self.storable.id], [6.0, 6.0])

    def test_07_pending_quantities_other_terminal(self):
        """A second POS selling from the same location reduces the stock
        seen by the first one; a POS on another location does not."""
        self.company.point_of_sale_update_stock_quantities = 'closing'
        self._set_qty(self.storable, self.wh_stock, 10)
        self.config = self._new_config('PRSQ Second Terminal')
        self.open_new_session()
        self.env['pos.order'].sync_from_ui([
            self.create_ui_order_data([(self.storable, 2)], payments=[(self.bank_pm1, 20.0)])])
        self.assertEqual(self.basic_config._prsq_compute_stock_map([self.storable.id])[self.storable.id][0], 8.0)

        self.basic_config.write({'prsq_location_scope': 'location', 'prsq_location_id': self.backroom.id})
        self.assertEqual(self.basic_config._prsq_compute_stock_map([self.storable.id])[self.storable.id][0], 0.0)

    def test_08_payload_embeds_stock_map(self):
        self._set_qty(self.storable, self.wh_stock, 5)
        self.config.prsq_exempt_product_ids = [(6, 0, self.storable_2.ids)]
        session = self.open_new_session()
        data = session.load_data([])
        config_vals = data['pos.config'][0]

        settings = config_vals['_prsq_settings']
        self.assertTrue(settings['active'])
        self.assertTrue(settings['restrict'])
        self.assertEqual(settings['basis'], 'on_hand')
        self.assertEqual(settings['mode'], 'block')
        self.assertEqual(settings['exempt_product_ids'], self.storable_2.ids)
        self.assertEqual(settings['location_name'], self.wh_stock.display_name)

        # The map covers every product variant sent to the POS (on pos.config)
        stock_map = config_vals['_prsq_stock_map']
        loaded_ids = {p['id'] for p in data['product.product']}
        self.assertEqual(set(stock_map), {str(pid) for pid in loaded_ids})
        self.assertEqual(stock_map[str(self.storable.id)], [5.0, 5.0])
        self.assertEqual(stock_map[str(self.storable_2.id)], [0.0, 0.0])
        self.assertIs(stock_map[str(self.consumable.id)], False)

        # Products loaded later (search / barcode / local cache) are refreshed
        result = session.prsq_get_stock_map([self.storable.id])
        self.assertEqual(result['stock'], {str(self.storable.id): [5.0, 5.0]})

    def test_09_inactive_config_skips_computation(self):
        self.config.write({
            'prsq_show_stock': False, 'prsq_show_forecast': False, 'prsq_restrict_out_of_stock': False})
        session = self.open_new_session()
        data = session.load_data([])
        config_vals = data['pos.config'][0]
        self.assertFalse(config_vals['_prsq_settings']['active'])
        self.assertNotIn('_prsq_stock_map', config_vals)
        self.assertEqual(session.prsq_get_stock_map([self.storable.id])['stock'], {})

    def test_10_refresh_endpoint(self):
        self._set_qty(self.storable, self.wh_stock, 9)
        session = self.open_new_session()
        result = session.prsq_get_stock_map([self.storable.id, self.consumable.id])
        self.assertEqual(result['stock'], {str(self.storable.id): [9.0, 9.0], str(self.consumable.id): False})
        self.assertTrue(result['server_time'])

    def test_11_pos_user_can_refresh(self):
        """The refresh RPC works for a cashier without any inventory group."""
        self._set_qty(self.storable, self.wh_stock, 2)
        session = self.open_new_session()
        cashier = self.env['res.users'].create({
            'name': 'PRSQ Cashier',
            'login': 'prsq_cashier',
            'company_id': self.company.id,
            'company_ids': [(6, 0, self.company.ids)],
            'group_ids': [(6, 0, [self.env.ref('base.group_user').id,
                                  self.env.ref('point_of_sale.group_pos_user').id])],
        })
        self.assertFalse(cashier.has_group('stock.group_stock_user'))
        result = session.with_user(cashier).prsq_get_stock_map([self.storable.id])
        self.assertEqual(result['stock'][str(self.storable.id)], [2.0, 2.0])

    def test_12_constraints(self):
        with self.assertRaises(ValidationError):
            self.config.write({'prsq_location_scope': 'location', 'prsq_location_id': False})
        with self.assertRaises(ValidationError):
            self.config.prsq_refresh_interval = -1

    def test_13_per_pos_settings(self):
        """Settings are stored per pos.config: editing one POS through the
        settings screen does not touch another one."""
        other_config = self._new_config('PRSQ Other Shop')
        other_config.write({'prsq_restrict_out_of_stock': False, 'prsq_restriction_mode': 'block'})

        with Form(self.env['res.config.settings']) as form:
            form.pos_config_id = self.config
            form.pos_prsq_restrict_out_of_stock = True
            form.pos_prsq_restriction_mode = 'warn'
            form.pos_prsq_restriction_basis = 'forecast'
            form.pos_prsq_refresh_interval = 0
        self.assertEqual(self.config.prsq_restriction_mode, 'warn')
        self.assertEqual(self.config.prsq_restriction_basis, 'forecast')
        self.assertEqual(self.config.prsq_refresh_interval, 0)
        self.assertFalse(other_config.prsq_restrict_out_of_stock)
        self.assertEqual(other_config.prsq_restriction_mode, 'block')
