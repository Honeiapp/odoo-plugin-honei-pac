{
    "name": "honei Terminal",

    "summary": "Pago con honei Terminal",

    "description": """
Procesa pagos a través de honei Terminal.
    """,

    "author": "honei",
    "website": "https://www.honei.app",
    "category": "Point of Sale",
    "version": "19.0.0.5.0",
    "license": "Other proprietary",

    "depends": [
        "base",
        "point_of_sale",
    ],

    "data": [
        "security/ir.model.access.csv",
        "views/pos_config.xml",
        "views/pos_payment_method.xml",
        "views/pos_order.xml",
    ],

    "assets": {
        "point_of_sale._assets_pos": [
            "honei_terminal/static/src/css/honei_terminal.css",
            "honei_terminal/static/src/js/honei_validation_popup.js",
            "honei_terminal/static/src/js/order_payment_validation.js",
            "honei_terminal/static/src/js/pos_store.js",
            "honei_terminal/static/src/js/navbar.js",
            "honei_terminal/static/src/js/payment_screen.js",
            "honei_terminal/static/src/xml/honei_validation_popup.xml",
            "honei_terminal/static/src/xml/navbar.xml",
        ],
    },
}
