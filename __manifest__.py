{
    "name": "Honei Terminal",

    "summary": "Pago con Honei Terminal",

    "description": """
Procesa pagos a través de Honei Terminal.
    """,

    "author": "honei",
    "website": "https://www.honei.app",
    "category": "Point of Sale",
    "version": "0.1.0",
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
            "honei_terminal/static/src/js/honei_validation_popup.js",
            "honei_terminal/static/src/js/payment_screen.js",
            "honei_terminal/static/src/xml/honei_validation_popup.xml",
        ],
    },
}
