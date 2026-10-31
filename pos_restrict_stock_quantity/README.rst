===========================
POS Restrict Stock Quantity
===========================

Odoo 17.0 - Community & Enterprise - depends only on ``point_of_sale``.

Features
========

* **Stock badges** on POS product cards: green (in stock), red (out of stock)
  and an optional blue badge with the forecasted quantity. Badges follow the
  cart in real time (quantities already in open orders are deducted).
* **Per-POS settings**: every option is a field of ``pos.config``, edited in
  *Point of Sale > Configuration > Settings* for the selected POS (or on the
  POS form), so each terminal has its own rules.
* **Warehouse / Operation Type mapping**: quantities are computed from the
  source location of the POS Operation Type, the whole warehouse, or a
  specific location (children included).
* **Restriction** of out-of-stock sales, based on on-hand or forecasted
  quantity, in *Block* or *Warn & allow override* mode. Enforced on product
  click, barcode scan, quantity edits (numpad) and, in Block mode, again at
  payment.
* **Exemptions**: "Manage Exempted Products" opens a tool with filters
  (name / reference / barcode, product & POS categories with children, tags,
  stock level, exemption status) and bulk actions (select all / invert,
  exempt / un-exempt selected, exempt / un-exempt *all matching* products).
* **Arabic** translation (``i18n/ar_001.po``) for settings, wizard, popups and
  badges.

Performance
===========

* The stock map ``[on_hand, forecast]`` is embedded in the product payload of
  ``load_pos_data`` (and of every later product load: background loading,
  search, barcode), computed with one batched ``_compute_quantities_dict``
  call per 5,000 products. No RPC is made while the cashier sells.
* After each synced order, only the sold products are refreshed in the
  background; an optional periodic refresh (minutes) and a *Refresh Stock*
  button reload the whole map.
* When stock is updated at session closing, quantities sold in open sessions
  of any POS using the same location are deducted server side, so several
  terminals cannot sell the same unit.

Tests
=====

::

    odoo-bin -d <db> -i pos_restrict_stock_quantity --test-enable \
        --test-tags /pos_restrict_stock_quantity --stop-after-init

* ``tests/test_stock_map.py`` - location scopes, operation type mapping,
  forecast, closing vs real-time stock update, multi-terminal pending
  quantities, payload embedding, cashier access, constraints, per-POS settings.
* ``tests/test_exemption_wizard.py`` - every filter (including products with several POS categories) and bulk action.
* ``tests/test_frontend.py`` - UI tours ``PosRestrictStockBlockTour`` and
  ``PosRestrictStockWarnTour`` (run as a POS user without Inventory rights: badges, ribbon, click / numpad / payment
  restriction, exemptions, consumables, post-sync refresh, warn override).

Author: Ibrahim Yahia - https://www.linkedin.com/in/ibrahim-yahia
