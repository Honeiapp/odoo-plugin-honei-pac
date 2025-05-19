/** @odoo-module **/

import {_t} from "@web/core/l10n/translation";
import {Component, useState} from "@odoo/owl";
import {Dialog} from "@web/core/dialog/dialog";

export class HoneiValidationPopup extends Component {
    static template = "honei_payment.HoneiValidationPopup";
    static components = {Dialog};

    static props = {
        close: Function,
        title: {type: String, optional: true},
        confirmText: {type: String, optional: true},
        cancelText: {type: String, optional: true},
        paymentMethodName: {type: String, optional: true},
        honeiConfigs: {type: Array, optional: true},
        token: {type: String, optional: false},
        onConfirm: {type: Function, optional: true},
        onCancel: {type: Function, optional: true},
        onError: {type: Function, optional: true},
    };

    static defaultProps = {
        title: _t("Processant Pagament Honei"),
        confirmText: _t("Continuar (Simulat)"),
        cancelText: _t("Cancel·lar"),
        honeiConfigs: [],
        onConfirm: () => {
        },
        onCancel: () => {
        },
        onError: () => {
        },
    };

    setup() {
        this.state = useState({
            selectedHoneiConfigId: null,
            selectedHoneiConfig: null,
            status: 'idle',
            errorMessage: '',
        });

        this._t = _t;
    }

    selectHoneiConfig(config) {
        this.state.selectedHoneiConfigId = config.id;
        this.state.selectedHoneiConfig = config;
        this.state.errorMessage = '';
        this.state.status = 'idle';
    }

    async confirm() {
        if (this.props.honeiConfigs && this.props.honeiConfigs.length > 0 && !this.state.selectedHoneiConfig) {
            this.state.errorMessage = this._t("Si us plau, selecciona una opció de pagament Honei.");
            this.state.status = 'error';
            return;
        }

        if (!this.props.token || this.props.token.trim() === "") {
            this.state.errorMessage = this._t("Token d'autenticació no vàlid.");
            this.state.status = 'error';
            return;
        }

        this.state.status = 'loading';
        this.state.errorMessage = '';

        await new Promise(resolve => setTimeout(resolve, 1500));
        const simulatedApiResponse = {
            transactionId: 'HON-SIM-' + Date.now(),
            status: 'done',
        };

        this.state.status = 'idle';
        this.props.onConfirm(this.state.selectedHoneiConfig, simulatedApiResponse);
        this.props.close();
    }

    cancel() {
        this.props.onCancel();
        this.props.close();
    }
}
