# -*- coding: utf-8 -*-
{
    'name': 'POS Restrict Stock Quantity',
    'version': '19.0.1.0.0',
    'summary': 'Real-time stock badges on POS products, per-POS out-of-stock '
               'restriction, warehouse / operation type mapping and bulk '
               'product exemptions.',
    'description': """
POS Restrict Stock Quantity
===========================
* Three-tier stock badges on POS product cards: green (in stock),
  red (out of stock) and blue (forecasted quantity).
* Every setting lives on the POS configuration record itself, so each
  terminal can have its own rules.
* Quantities are computed for the Operation Type source location, the whole
  warehouse or a specific location of each POS.
* Optional restriction of out-of-stock sales (block or warn & allow override),
  enforced on product clicks, barcode scans, quantity edits and at payment.
* Bulk exemption tool with advanced filters to exclude products from the rule.
* Stock map embedded in the initial POS payload (no runtime RPC while
  selling), refreshed in the background after each synced order.
* Full Arabic translation.
    """,
    'category': 'Sales/Point of Sale',
    'author': 'Ibrahim Yahia',
    'website': 'https://www.linkedin.com/in/ibrahim-yahia',
    'license': 'LGPL-3',
    'depends': ['point_of_sale'],
    'data': [
        'security/ir.model.access.csv',
        'wizard/prsq_exemption_wizard_views.xml',
        'views/pos_config_views.xml',
        'views/res_config_settings_views.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_restrict_stock_quantity/static/src/app/**/*',
        ],
        'web.assets_tests': [
            'pos_restrict_stock_quantity/static/tests/tours/**/*',
        ],
    },
    'images': ['static/description/banner.png'],
    'installable': True,
    'application': False,
    'auto_install': False,
}
