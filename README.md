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

## 2. Elegir el tipo de integración

El plugin puede hablar con el terminal de dos formas. Se elige en el método de pago (campo **Integración**) y aplica a todos los terminales del TPV que usen ese método.

| | **Cloud** (por defecto) | **Local** |
|---|---|---|
| Camino del cobro | Navegador del TPV → API de honei → terminal | Servidor Odoo → terminal, por la red local ([Local API](https://integration.terminal.honei.app/api-reference/pay-at-counter-and-apk/local-api)) |
| Internet | Necesario en cada cobro | Solo para vincular cada terminal (una vez) |
| Dónde está Odoo | En cualquier sitio (nube o local) | **En la misma red que los terminales** (Odoo instalado en el establecimiento) |
| Configuración del terminal | Terminal ID | Terminal ID + IP local + vinculación |
| Cancelar desde Odoo | Sí, si el terminal lo permite | Solo en **A77** y **A920 Pro**; en el resto, desde el terminal |

Con Odoo en la nube (Odoo.sh, odoo.com…) solo es posible **Cloud**.

---

## 3. Onboarding Cloud

### 3.1 Método de pago

1. Ve a **Punto de venta** → **Configuración** → **Métodos de pago**.
2. Crea un nuevo método o edita uno existente.
3. Rellena:
   - **Nombre**: p. ej. "Tarjeta honei".
   - Marca **honei Payment**.
   - **Integración**: **Cloud**.
   - **Venue API Key**: clave de API del establecimiento (se envía en el header `venue-api-key`).
   - **Entorno de pruebas (Staging)**:
     - Marcado → se usa `https://staging.api.honei.app/v1`.
     - Desmarcado → se usa `https://api.honei.app/v1` (producción).
   - **Odoo Integration Secret**: secreto de integración (se envía en el header `Authorization: Bearer`).
   - **Ir a la siguiente venta tras el pago** (recomendado para caja rápida):
     - Marcado → al completar el pago honei, Odoo registra la venta y abre **directamente una venta nueva**, sin pantalla de ticket ni botón de validar.
     - Desmarcado → flujo estándar de Odoo (pantalla de ticket / validación manual).
4. Guarda.
5. Añade el método de pago al **Punto de venta** donde se vaya a usar (**Punto de venta → Configuración → Punto de venta → Pagos**).

### 3.2 Terminales

1. Ve a **Punto de venta** → **Configuración** → **Punto de venta** y abre el TPV.
2. En la pestaña **honei Terminal**, añade una línea por cada terminal físico:
   - **Nombre**: nombre descriptivo (p. ej. "Datáfono caja 1"). Solo se muestra si hay varios terminales.
   - **Terminal ID**: identificador del terminal en honei.
3. Guarda.

### 3.3 Comprobación

1. Abre una sesión del POS, añade un producto y pulsa el método de pago honei.
2. El terminal debe mostrar la pantalla de cobro.

---

## 4. Onboarding Local

### 4.1 Requisitos

- Odoo instalado **en la misma red** que los terminales. El servidor Odoo debe poder abrir conexiones al puerto **8743** de cada terminal.
- App honei Terminal con Local API (device-bridge), con la sesión iniciada en el terminal.
- **Venue API Key** y **Odoo Integration Secret** del establecimiento: se usan solo para vincular los terminales.
- Internet en el servidor Odoo **en el momento de vincular** (o ver 4.5 si no hay).

### 4.2 IP fija para cada terminal

Asigna a cada terminal una IP fija en la red, normalmente con una **reserva DHCP** en el router. Si la IP cambia, Odoo dejará de encontrar el terminal hasta que actualices la IP en la configuración.

La IP del terminal se ve en los ajustes de red del propio terminal (Wi-Fi → red conectada).

### 4.3 Método de pago

Igual que en cloud (apartado 3.1), pero con **Integración: Local**. Rellena igualmente **Venue API Key**, **Entorno de pruebas** y **Odoo Integration Secret**, porque se necesitan para vincular.

### 4.4 Terminales: IP y vinculación

1. Ve a **Punto de venta** → **Configuración** → **Punto de venta** y abre el TPV.
2. En la pestaña **honei Terminal**, para cada terminal rellena **Nombre**, **Terminal ID** e **IP local** (p. ej. `192.168.1.50`; puerto 8743 por defecto, o `192.168.1.50:puerto`).
3. Guarda.
4. Pulsa **Vincular** en cada terminal. Odoo pide a honei la clave de firma y la huella del certificado del terminal y las guarda en el servidor; nunca llegan al navegador.
   - Si varios TPV usan el mismo Terminal ID, la clave se copia a todos.
   - ⚠️ Volver a vincular **rota la clave**: la anterior deja de funcionar al instante. Vincula cada terminal desde un único Odoo.
5. Revisa la columna **Estado local**:

| Estado | Significado |
|---|---|
| **Listo** | IP, clave y huella configuradas. |
| **Sin IP** | Falta la IP local. |
| **Sin vincular** | Falta pulsar **Vincular**. |
| **Sin huella** | El terminal aún no ha reportado su certificado a honei. Enciende el terminal, espera un minuto y vuelve a vincular. |

### 4.5 Vincular sin Internet en el local

Si el servidor Odoo no tiene salida a Internet, obtén la clave desde otro equipo llamando a la API de honei (`POST /terminals/:terminalId/device-bridge-key`, ver [Authorization](https://integration.terminal.honei.app/api-reference/pay-at-counter-and-apk/local-api/authorization)) y pega a mano **Secreto local** y **Huella del certificado** (columnas opcionales de la lista de terminales).

### 4.6 Comprobación

1. Pulsa **Probar** en cada terminal. Debe aparecer *"Conexión local con … correcta"*.
2. Abre una sesión del POS y haz un cobro de prueba.

---

## 5. Configurar el terminal por defecto (varios terminales)

Si un TPV tiene **más de un terminal honei**, el cajero debe elegir cuál usar por defecto antes de poder cobrar:

1. En la pantalla del POS, abre el menú **☰** (arriba a la derecha).
2. Pulsa **honei Terminal**.
3. Selecciona el terminal a usar (aparece marcado con un ✓).

A partir de ese momento, al pulsar el método de pago honei el cobro se inicia directamente en ese terminal, sin pantalla de selección. Puedes cambiar el terminal por defecto repitiendo estos pasos en cualquier momento; la elección se guarda por TPV y persiste aunque recargues la página.

Si hay un único terminal configurado, se usa automáticamente y aparece siempre marcado como seleccionado en el menú (no hace falta elegirlo).

Si se intenta cobrar sin haber elegido terminal por defecto (con varios terminales disponibles), aparece un aviso: *"Selecciona un terminal por defecto"*, indicando estos mismos pasos.

**Recomendación:** configura **un solo terminal por TPV**. Con un único terminal, al pulsar el método de pago honei el cobro se inicia automáticamente, sin paso de selección.

Los cambios en terminales (añadir, editar o borrar) se **sincronizan al instante** cada vez que el cajero pulsa el método de pago honei; no hace falta cerrar y reabrir la sesión del POS.

---

## 6. Uso en el Punto de venta

1. Abre una sesión del Punto de venta (o inicia una nueva).
2. Añade productos a la orden.
3. Pulsa el método de pago configurado como **honei**. Si el importe pendiente es 0, aparece un aviso y no se inicia ningún cobro.
4. Se abre el popup de procesamiento y el terminal muestra la pantalla de cobro.
5. El cliente paga en el datáfono; en pantalla verás el estado del pago.
6. **Pago correcto:**
   - Con **Ir a la siguiente venta tras el pago** activado → la venta se registra y vuelves a la pantalla de venta nueva.
   - Sin esa opción → flujo normal de Odoo (validar / ticket).
7. **Pago rechazado o cancelado** → se muestra un mensaje de error en el popup; el cajero puede reintentar o cerrar.

Las devoluciones funcionan igual: al cobrar una orden de devolución con el método honei se devuelve el importe sobre el pago honei original.

### Cancelar un pago en curso

- **Cloud:** pulsa **Cancelar pago** en el popup (si el terminal lo permite). Se envía el aborto a la API de honei.
- **Local:** en **A77** y **A920 Pro** aparece **Cancelar pago** en el popup. En el resto de modelos el popup indica que se cancele desde el terminal.

### Salir sin esperar

Si el popup lleva **2 minutos** esperando el resultado, aparece el botón **Salir**. Pide confirmación porque el cobro puede seguir en curso en el terminal: si se completa después de salir, Odoo no lo registrará. Comprueba en el terminal que no se ha cobrado antes de salir.

### Recarga de la página a mitad de cobro

Si se recarga el POS durante un cobro, al volver se reanuda la consulta de ese mismo cobro. Nunca se lanza un segundo cobro por la recarga.

### Descargar los logs

El plugin guarda un registro interno de la actividad de los pagos honei (sincronización de terminales, inicio/fin de cobro, errores, etc.), útil para diagnosticar incidencias.

Para descargarlo:

1. En la pantalla del POS, abre el menú **☰**.
2. Pulsa **honei Terminal**.
3. Pulsa **Descargar logs**.

Se descarga un archivo de texto `honei-logs-<fecha>.txt` con una línea por evento (fecha, nivel y datos). Compártelo con soporte de honei si necesitas ayuda con una incidencia.

---

## 7. Comportamiento del plugin (resumen)

| Funcionalidad | Descripción |
|---------------|-------------|
| Integración cloud o local | Se elige por método de pago; por defecto cloud. |
| Sincronización de terminales | Al pulsar honei, se consulta el servidor y se actualiza la lista de terminales del TPV. |
| Un terminal por TPV | Sin selector: el cobro arranca directamente. |
| Siguiente venta automática | Opción en el método de pago; salta ticket y validación manual. |
| Cancelar desde el popup | Cloud: si el terminal lo permite. Local: A77 y A920 Pro. |
| Salir sin esperar | Tras 2 minutos esperando, con confirmación. |
| Reanudar tras recarga | Se vuelve a consultar el mismo cobro; nunca se cobra dos veces. |
| Validación automática | Tras un pago honei correcto, se añade la línea de pago y se valida la orden sin pasos extra. |

---

## 8. Resolución de problemas

### El módulo no aparece en Apps

- Comprueba que la carpeta en addons se llame exactamente **`honei_terminal`**.
- Pulsa **Actualizar lista de aplicaciones** en Apps.
- Si usas Docker, reinicia Odoo después de copiar el módulo.

### Los estilos del POS se ven mal o el popup no carga

- En la base de datos se pueden haber quedado assets cacheados. Ejemplo con Docker:

  ```bash
  docker compose exec db psql -U odoo -d db -c "DELETE FROM ir_attachment WHERE name LIKE '%assets%' AND res_model = 'ir.ui.view';"
  docker compose restart odoo
  ```

- Luego cierra la pestaña del POS, vuelve a abrirlo y recarga con caché vacía (Ctrl+Shift+R o Cmd+Shift+R). Si sigue cargando la versión anterior, en DevTools → **Application → Service Workers** pulsa **Unregister** y recarga.

### Error "Venue API Key no configurada" o "Odoo Integration Secret no configurado"

- Revisa en **Métodos de pago** que el método honei tenga rellenados **Venue API Key** y **Odoo Integration Secret**.

### Error "No se han encontrado configuraciones de pago honei válidas"

- En la configuración del **Punto de venta** (pestaña **honei Terminal**) debe haber al menos un terminal con **Nombre** y **Terminal ID**.

### Los terminales no se actualizan tras borrar o añadir uno en configuración

- Recarga el POS (F5). Si persiste, comprueba que el módulo esté en la versión **19.0.0.2.0** o superior y actualizado en la base de datos.

### Local: "No se puede conectar con el terminal en la red local"

- Comprueba que el terminal está encendido, con la app honei Terminal abierta y la sesión iniciada.
- Comprueba que la **IP local** es la actual del terminal y que el servidor Odoo llega a ella (misma red, sin aislamiento de clientes Wi-Fi ni firewall en el puerto 8743).
- Si el terminal no se ha vinculado nunca, su servidor local no está arrancado: pulsa **Vincular**.

### Local: "El certificado del terminal no coincide con la huella guardada"

- El terminal ha regenerado su certificado (p. ej. tras reinstalar la app o borrar sus datos). Pulsa **Vincular** de nuevo.

### Local: "El terminal ha rechazado la firma" o "no tiene clave de integración local"

- La clave se ha rotado desde otro sitio o el terminal ha cerrado sesión. Pulsa **Vincular** de nuevo (y, si hace falta, inicia sesión en el terminal).

### Local: error y "Comprueba en el terminal si el cobro se ha completado"

- Se perdió la comunicación con el cobro ya iniciado. Mira en el terminal si se ha cobrado y pulsa **Reintentar**: vuelve a consultar ese mismo cobro, no lanza otro.

---

## 9. Estructura del módulo (referencia)

```
honei_terminal/
├── __init__.py
├── __manifest__.py
├── models/
│   ├── device_bridge.py          # Cliente de la Local API (HMAC, huella del certificado)
│   ├── honei_terminal.py         # Terminales + vinculación y operaciones locales
│   ├── pos_config.py             # Terminales + sync_honei_terminals_pos_data
│   ├── pos_order.py              # Datos del pago original para devoluciones
│   ├── pos_payment_method.py     # Credenciales, integración cloud/local, honei_auto_next_order
│   └── pos_session.py            # Carga de terminales en sesión POS
├── security/
│   └── ir.model.access.csv
├── views/
│   ├── pos_config.xml            # Pestaña honei Terminal
│   ├── pos_payment_method.xml
│   └── pos_order.xml
├── static/
│   ├── description/
│   │   └── icon.png
│   └── src/
│       ├── css/
│       │   └── honei_terminal.css
│       ├── js/
│       │   ├── honei_logger.js             # Logs descargables
│       │   ├── honei_validation_popup.js   # Popup: cobro cloud/local, polling, cancelar
│       │   ├── navbar.js                   # Menú honei Terminal
│       │   ├── order_payment_validation.js # Siguiente venta sin ticket
│       │   ├── payment_screen.js           # Pago honei + sync terminales
│       │   └── pos_store.js                # Reanudar cobro tras recarga
│       └── xml/
│           ├── honei_validation_popup.xml
│           └── navbar.xml
└── README.md
```

---

## Licencia

Other proprietary – honei.
