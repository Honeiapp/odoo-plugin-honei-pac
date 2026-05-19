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

**Ejemplo con Docker** (este repositorio ya monta el código en el contenedor):

```bash
# El docker-compose.yml monta el repo en /mnt/extra-addons/honei_terminal
docker compose up -d
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

Reinicia el contenedor de Odoo después de copiar o actualizar el módulo:

```bash
docker compose restart odoo
```

Luego realiza los pasos del apartado 1.2 en la interfaz.

### 1.4 Actualizar el módulo (tras cambios de código)

Si añades campos nuevos o actualizas el plugin, hay que **actualizar el módulo en la base de datos**:

**Desde Odoo:** Apps → Honei Terminal → Actualizar.

**Desde terminal (Docker):**

```bash
docker compose exec odoo odoo -u honei_terminal -d db --stop-after-init --db_host=db --db_user=odoo --db_password=odoo
docker compose up -d odoo
```

Sustituye `db` por el nombre de tu base de datos si es distinto.

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
   - **Ir a la siguiente venta tras el pago** (recomendado para caja rápida):
     - Marcado → al completar el pago honei, Odoo registra la venta y abre **directamente una venta nueva**, sin pantalla de ticket ni botón de validar.
     - Desmarcado → flujo estándar de Odoo (pantalla de ticket / validación manual).
4. Guarda.

---

## 3. Configuración de terminales Honei

1. Ve a **Punto de venta** → **Configuración**.
2. Abre el **Punto de venta** donde quieras usar Honei.
3. En la pestaña **Honei Terminal**, en la lista **Terminales Honei**:
   - Añade una línea por cada terminal físico.
   - **Nombre**: nombre descriptivo (p. ej. "Datáfono caja 1"). Solo se usa si hay varios terminales.
   - **Terminal ID**: identificador del terminal en Honei (código que usa la API).
4. Guarda.

**Recomendación:** configura **un solo terminal por TPV**. Con un único terminal, al pulsar el método de pago honei el cobro se inicia automáticamente, sin paso de selección.

Los cambios en terminales (añadir, editar o borrar) se **sincronizan al instante** cada vez que el cajero pulsa el método de pago honei; no hace falta cerrar y reabrir la sesión del POS.

---

## 4. Uso en el Punto de venta

1. Abre una sesión del Punto de venta (o inicia una nueva).
2. Añade productos a la orden.
3. Pulsa el método de pago configurado como **Honei**.
4. Según la configuración:
   - **Un terminal** → el pago se inicia al momento (popup de procesamiento con el datáfono).
   - **Varios terminales** → elige el terminal y pulsa **Confirmar pago**.
5. El cliente paga en el datáfono; en pantalla verás el estado del pago.
6. **Pago correcto:**
   - Con **Ir a la siguiente venta tras el pago** activado → la venta se registra y vuelves a la pantalla de venta nueva.
   - Sin esa opción → flujo normal de Odoo (validar / ticket).
7. **Pago rechazado o cancelado** → se muestra un mensaje de error en el popup; el cajero puede reintentar o cerrar.

### Cancelar un pago en curso

Mientras el datáfono está procesando el cobro:

- Pulsa **Cancelar pago** en el popup, o
- Pulsa **Atrás** en el TPV.

En ambos casos se envía la petición de aborto a la API de Honei y se libera el datáfono, para que el cajero pueda seguir operando sin reiniciar la sesión.

---

## 5. Comportamiento del plugin (resumen)

| Funcionalidad | Descripción |
|---------------|-------------|
| Sincronización de terminales | Al pulsar honei, se consulta el servidor y se actualiza la lista de terminales del TPV. |
| Un terminal por TPV | Sin selector: el cobro arranca directamente. |
| Siguiente venta automática | Opción en el método de pago; salta ticket y validación manual. |
| Abortar con Atrás | Cancela el pago pendiente en el datáfono vía API. |
| Validación automática | Tras un pago honei correcto, se añade la línea de pago y se valida la orden sin pasos extra. |

---

## 6. Resolución de problemas

### El módulo no aparece en Apps

- Comprueba que la carpeta en addons se llame exactamente **`honei_terminal`**.
- Pulsa **Actualizar lista de aplicaciones** en Apps.
- Si usas Docker, reinicia Odoo después de copiar el módulo.

### Error de columna inexistente (p. ej. `honei_auto_next_order does not exist`)

El módulo no se ha actualizado en la base de datos. Actualízalo (apartado 1.4) y recarga el POS.

### Los estilos del POS se ven mal o el popup no carga

- En la base de datos se pueden haber quedado assets cacheados. Ejemplo con Docker:

  ```bash
  docker compose exec db psql -U odoo -d db -c "DELETE FROM ir_attachment WHERE name LIKE '%assets%' AND res_model = 'ir.ui.view';"
  docker compose restart odoo
  ```

- Luego cierra la pestaña del POS, vuelve a abrirlo y recarga con caché vacía (Ctrl+Shift+R o Cmd+Shift+R).

### Error "Venue API Key no configurada" o "Odoo Integration Secret no configurado"

- Revisa en **Métodos de pago** que el método Honei tenga rellenados **Venue API Key** y **Odoo Integration Secret**.

### Error "No se han encontrado configuraciones de pago Honei válidas"

- En la configuración del **Punto de venta** (pestaña **Honei Terminal**) debe haber al menos un terminal con **Nombre** y **Terminal ID**.

### Los terminales no se actualizan tras borrar o añadir uno en configuración

- Recarga el POS (F5). Si persiste, comprueba que el módulo esté en la versión **19.0.0.2.0** o superior y actualizado en la base de datos.

### El datáfono queda bloqueado tras pulsar Atrás

- Asegúrate de tener la versión actual del plugin (aborto automático al pulsar Atrás o cerrar el popup durante el pago).
- Si el datáfono sigue bloqueado, puede ser un estado del terminal; reinicia la sesión del POS o el datáfono según el manual de Honei.

### Errores de red o CORS al llamar a la API

- Si la API de Honei no acepta peticiones desde el origen de tu Odoo (p. ej. `http://localhost:8069`), hay que configurar CORS en el backend de Honei para ese origen, o exponer las llamadas vía un proxy en tu servidor.

---

## 7. Estructura del módulo (referencia)

```
honei_terminal/
├── __init__.py
├── __manifest__.py
├── models/
│   ├── honei_terminal.py         # Modelo pos.config.honei_terminal (terminales)
│   ├── pos_config.py             # Terminales + sync_honei_terminals_pos_data
│   ├── pos_payment_method.py     # Credenciales API + honei_auto_next_order
│   └── pos_session.py            # Carga de terminales en sesión POS
├── security/
│   └── ir.model.access.csv
├── views/
│   ├── pos_config.xml            # Pestaña Honei Terminal
│   ├── pos_payment_method.xml
│   └── pos_order.xml
├── static/
│   ├── description/
│   │   └── icon.png
│   └── src/
│       ├── css/
│       │   └── honei_terminal.css
│       ├── js/
│       │   ├── payment_screen.js           # Pago honei + sync terminales
│       │   ├── honei_validation_popup.js     # Popup, API y aborto
│       │   ├── order_payment_validation.js   # Siguiente venta sin ticket
│       │   └── pos_store.js                  # Atrás cancela pago pendiente
│       └── xml/
│           └── honei_validation_popup.xml
└── README.md
```

---

## Licencia

Other proprietary – honei.
