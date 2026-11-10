/* Browser ceremonies stay on Network; product sites continue through central SSO. */
window.networkPasskeys = {
    library: () => import('/vendor/passkeys/index.js'),
    async authenticate(call, purpose = 'login', conditional = false) {
        const lib = await this.library();
        const optionsJSON = await call(purpose + '/options', {});
        const response = await lib.startAuthentication({ optionsJSON, useBrowserAutofill: conditional });
        return call(purpose + '/verify', { response });
    },
    async register(call, credentials, name) {
        const lib = await this.library();
        const setup = await call('register/options', credentials);
        const response = await lib.startRegistration({ optionsJSON: setup.options });
        return call('register/verify', { state: setup.state, response, name });
    },
};
