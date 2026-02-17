/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { Component, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";

const POLL_INTERVAL_MS = 2000;

export class HoneiValidationPopup extends Component
{
    static template = "honei_terminal.HoneiValidationPopup";
    static components = { Dialog };

    static props = {
        close: Function,
        title: { type: String, optional: true },
        confirmText: { type: String, optional: true },
        cancelText: { type: String, optional: true },
        paymentMethodName: { type: String, optional: true },
        honeiConfigs: { type: Array, optional: true },
        venueApiKey: { type: String, optional: true },
        integrationSecret: { type: String, optional: true },
        apiBaseUrl: { type: String, optional: true },
        amount: { type: Number, optional: false },
        currency: { type: String, optional: true },
        onConfirm: { type: Function, optional: true },
        onCancel: { type: Function, optional: true },
        onError: { type: Function, optional: true },
    };

    static defaultProps = {
        title: _t( "Procesando pago Honei" ),
        confirmText: _t( "Confirmar pago" ),
        cancelText: _t( "Cancelar" ),
        currency: "EUR",
        honeiConfigs: [],
        onConfirm: () => { },
        onCancel: () => { },
        onError: () => { },
    };

    setup()
    {
        this.state = useState( {
            selectedHoneiConfigId: null,
            selectedHoneiConfig: null,
            status: "idle",
            errorMessage: "",
            statusMessage: "",
        } );

        this._t = _t;
        this._polling = false;
    }

    selectHoneiConfig( config )
    {
        this.state.selectedHoneiConfigId = config.id;
        this.state.selectedHoneiConfig = config;
        this.state.errorMessage = "";
        this.state.status = "idle";
    }

    _getHeaders()
    {
        return {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.props.integrationSecret || ""}`,
            "venue-api-key": this.props.venueApiKey || "",
        };
    }

    async _initPayment( terminalId, amount, currency )
    {
        const url = `${this.props.apiBaseUrl || ""}/terminals/${terminalId}/init-payment`;
        const response = await fetch( url, {
            method: "POST",
            headers: this._getHeaders(),
            body: JSON.stringify( { amount, currency } ),
        } );

        if ( !response.ok )
        {
            const error = await response.json().catch( () => ( {} ) );
            throw new Error( error.reason || error.message || `Error ${response.status}` );
        }

        return await response.json();
    }

    async _pollPaymentStatus( statusUrl )
    {
        this._polling = true;

        while ( this._polling )
        {
            const response = await fetch( statusUrl, {
                method: "GET",
                headers: this._getHeaders(),
            } );

            if ( !response.ok )
            {
                const error = await response.json().catch( () => ( {} ) );
                throw new Error( error.reason || error.message || `Error ${response.status}` );
            }

            const data = await response.json();

            if ( data.status !== "processing" )
            {
                this._polling = false;
                return data;
            }

            await new Promise( ( resolve ) => setTimeout( resolve, POLL_INTERVAL_MS ) );
        }

        return { status: "cancelled" };
    }

    async confirm()
    {
        if ( this.props.honeiConfigs?.length > 0 && !this.state.selectedHoneiConfig )
        {
            this.state.errorMessage = this._t( "Por favor, selecciona una opción de pago Honei." );
            this.state.status = "error";
            return;
        }

        if ( !this.props.venueApiKey?.trim() )
        {
            this.state.errorMessage = this._t( "Venue API Key no configurada." );
            this.state.status = "error";
            return;
        }
        if ( !this.props.integrationSecret?.trim() )
        {
            this.state.errorMessage = this._t( "Odoo Integration Secret no configurado." );
            this.state.status = "error";
            return;
        }
        if ( !this.state.selectedHoneiConfig )
        {
            this.state.errorMessage = this._t( "Selecciona un terminal de pago." );
            this.state.status = "error";
            return;
        }

        const terminalId = this.state.selectedHoneiConfig.code;
        const amount = this.props.amount;
        const currency = this.props.currency;

        try
        {
            this.state.status = "loading";
            this.state.statusMessage = this._t( "Iniciando pago..." );
            this.state.errorMessage = "";

            const initResult = await this._initPayment( terminalId, amount, currency );

            this.state.status = "processing";
            this.state.statusMessage = this._t( "Esperando confirmación en el terminal..." );

            const statusResult = await this._pollPaymentStatus( initResult.paymentStatusUrl );

            if ( statusResult.status === "completed" )
            {
                this.state.status = "completed";
                const apiResponse = {
                    transactionId: initResult.paymentId,
                    status: "done",
                    tip: statusResult.tip || 0,
                };
                this.props.onConfirm( this.state.selectedHoneiConfig, apiResponse );
                this.props.close();
            } else
            {
                const messages = {
                    declined: this._t( "El pago ha sido rechazado." ),
                    not_completed: this._t( "El pago no se ha completado." ),
                    timed_out: this._t( "El pago ha excedido el tiempo de espera." ),
                    cancelled: this._t( "El pago ha sido cancelado." ),
                };
                this.state.status = "error";
                this.state.errorMessage =
                    messages[statusResult.status] || this._t( "Error desconocido en el pago." );
            }
        } catch ( error )
        {
            this.state.status = "error";
            this.state.errorMessage =
                error.message || this._t( "Error de conexión con el servidor Honei." );
        }
    }

    cancel()
    {
        this._polling = false;
        this.props.onCancel();
        this.props.close();
    }
}
