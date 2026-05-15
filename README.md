# Honei Terminal – Plugin Odoo

Procesa pagos a través de Honei Terminal desde el Punto de venta de Odoo.

---

## Requisitos

- Odoo 19
- Módulo **Punto de venta** instalado

---

## 1. Instalación del plugin

### 1.1 Copiar el módulo en Odoo

El plugin debe estar en la ruta de addons de Odoo con el nombre **`honei_terminal`** (necesario para que coincidan las rutas de assets).

**Ejemplo con Docker:**

```bash
# Sustituye /ruta/odoo por la ruta de tu proyecto Odoo
cp -r /ruta/al/repo/odoo-plugin-honei-pac /ruta/odoo/addons/honei_terminal
```

**Ejemplo sin Docker** (Odoo instalado en el sistema):

```bash
cp -r /ruta/al/repo/odoo-plugin-honei-pac /ruta/odoo/addons/honei_terminal
```

### 1.2 Actualizar la lista de aplicaciones

1. Entra en Odoo como administrador.
2. Ve a **Apps**.
3. Quita el filtro "Apps" si está activo.
4. Pulsa el botón **Actualizar lista de aplicaciones** (icono de actualizar).
5. Busca **"Honei Terminal"**.
6. Pulsa **Instalar**.

### 1.3 Si usas Docker

Reinicia el contenedor de Odoo después de copiar el módulo:

```bash
docker compose restart odoo
```

Luego realiza los pasos del apartado 1.2 en la interfaz.

---

## 2. Configuración del método de pago

1. Ve a **Punto de venta** → **Configuración** → **Métodos de pago**.
2. Crea un nuevo método o edita uno existente.
3. Rellena:
   - **Nombre**: p. ej. "Tarjeta Honei" o "Honei Terminal".
   - Marca **Honei Payment**.
   - **Venue API Key**: clave de API del establecimiento (se envía en el header `venue-api-key`).
   - **Entorno de pruebas (Staging)**:
     - Marcado → se usa `https://staging.api.honei.app/v1`.
     - Desmarcado → se usa `https://api.honei.app/v1` (producción).
   - **Odoo Integration Secret**: secreto de integración (se envía en el header `Authorization: Bearer`).
4. Guarda.

---

## 3. Configuración de terminales Honei

1. Ve a **Punto de venta** → **Configuración**.
2. Abre el **Punto de venta** donde quieras usar Honei.
3. En la pestaña **Honei Terminal**, en la lista **Terminales Honei**:
   - Añade una línea por cada terminal físico.
   - **Nombre**: nombre que verá el cajero (p. ej. "Terminal 1", "Caja principal").
   - **Terminal ID**: identificador del terminal en Honei (código que usa la API).
4. Guarda.

---

## 4. Uso en el Punto de venta

1. Abre una sesión del Punto de venta (o inicia una nueva).
2. Añade productos a la orden.
3. En el pago, elige el método de pago configurado como Honei.
4. En el popup:
   - Elige el **terminal** donde se hará el pago.
   - Pulsa **Confirmar pago**.
5. En el terminal físico el cliente realiza el pago; en pantalla se muestra "Esperando confirmación en el terminal...".
6. Al completarse el pago en el terminal, la línea de pago se confirma y se puede finalizar la venta.

---

## 5. Resolución de problemas

### El módulo no aparece en Apps

- Comprueba que la carpeta en addons se llame exactamente **`honei_terminal`**.
- Pulsa **Actualizar lista de aplicaciones** en Apps.
- Si usas Docker, reinicia Odoo después de copiar el módulo.

### Los estilos del POS se ven mal o el popup no carga

- En la base de datos se pueden haber quedado assets cacheados. Ejemplo con Docker:

  ```bash
  docker compose exec db psql -U odoo -d TU_BASE_DE_DATOS -c "DELETE FROM ir_attachment WHERE name LIKE '%assets%' AND res_model = 'ir.ui.view';"
  docker compose restart odoo
  ```

- Luego cierra la pestaña del POS, vuelve a abrirlo y recarga con caché vacía (Ctrl+Shift+R o Cmd+Shift+R).

### Error "Venue API Key no configurada" o "Odoo Integration Secret no configurado"

- Revisa en **Métodos de pago** que el método Honei tenga rellenados **Venue API Key** y **Odoo Integration Secret**.

### Error "No se han encontrado configuraciones de pago Honei válidas"

- En la configuración del **Punto de venta** (pestaña **Honei Terminal**) debe haber al menos un terminal con **Nombre** y **Terminal ID**.

### Errores de red o CORS al llamar a la API

- Si la API de Honei no acepta peticiones desde el origen de tu Odoo (p. ej. `http://localhost:8069`), hay que configurar CORS en el backend de Honei para ese origen, o exponer las llamadas vía un proxy en tu servidor.

---

## 6. Estructura del módulo (referencia)

```
honei_terminal/
├── __init__.py
├── __manifest__.py
├── models/
│   ├── honei_terminal.py    # Modelo pos.config.honei_terminal (terminales)
│   ├── pos_config.py        # honei_terminal_ids y carga de datos en POS
│   └── pos_payment_method.py # Venue API Key, Staging, Odoo Integration Secret
├── security/
│   └── ir.model.access.csv
├── views/
│   ├── pos_config.xml       # Pestaña Honei Terminal
│   ├── pos_payment_method.xml
│   └── pos_order.xml
├── static/
│   ├── description/
│   │   └── icon.png
│   └── src/
│       ├── js/
│       │   ├── payment_screen.js      # Integración en pantalla de pago
│       │   └── honei_validation_popup.js # Popup y llamadas a la API
│       └── xml/
│           └── honei_validation_popup.xml
└── README.md
```

---

## Licencia

Other proprietary – honei.
