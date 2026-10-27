sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/UIComponent",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "../model/formatter"
], (Controller, UIComponent, JSONModel, MessageBox, formatter) => {
    "use strict";

    return Controller.extend("rbx.ecrf.uimodule.controller.BaseController", {

        formatter: formatter,

        getModel(sName) {
            return this.getView().getModel(sName) || this.getOwnerComponent().getModel(sName);
        },

        getRouter() {
            return UIComponent.getRouterFor(this);
        },

        getResourceBundle() {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle();
        },

        /**
         * Calls testFunction every 100ms until it returns true (max 50 times = 5 sec),
         * then calls callbackFunction with hasLoaded (true/false) as the last param.
         */
        checkUntillFound(testFunction, callbackFunction, context, arrayOfParams) {
            const MAX_TIMES_IT_SHOULD_CHECK = 50;
            let checkingTime = 0;
            const timer = setInterval(() => {
                const hasLoaded = !!testFunction();
                if (hasLoaded || ++checkingTime >= MAX_TIMES_IT_SHOULD_CHECK) {
                    window.clearInterval(timer);
                    callbackFunction.apply(context, (arrayOfParams || []).concat(hasLoaded));
                }
            }, 100);
        },

        /**
         * Builds the URL for a key from the "servers" model (model/servers.json).
         * sProperty can be a key ("usersAPI") or { propertyName, replaceVars: { id: 5 } }
         * to fill extra {placeholders}. A path starting with "/" is used as is.
         */
        getServerPropertyUrl(sProperty, projectId, serverName) {
            let property;
            if (typeof sProperty === "object") {
                property = this.getModel("servers").getProperty("/" + sProperty.propertyName);
                Object.keys(sProperty.replaceVars || {}).forEach((key) => {
                    property = property.replace("{" + key + "}", sProperty.replaceVars[key]);
                });
            } else if (sProperty.startsWith("/")) {
                property = "{server_name}" + sProperty;
            } else {
                property = this.getModel("servers").getProperty("/" + sProperty);
            }
            if (!property) {
                throw new Error(`No API url configured for "${sProperty.propertyName || sProperty}" in model/servers.json`);
            }
            return property
                .replace("{server_name}", serverName)
                .replace("{project_id}", projectId ?? "");
        },

        /**
         * Resolves the full URL once the app config (roui.domain) has been loaded.
         */
        getApiCall_V2(sProperty) {
            const that = this;
            let count = 0;
            return new Promise((resolve, reject) => {
                function testFunction() {
                    return that.getModel()?.getProperty("/roui/domain") !== undefined;
                }

                function callbackFunction(hasPassedTest) {
                    if (hasPassedTest) {
                        try {
                            const data = that.getModel().getData();
                            resolve(that.getServerPropertyUrl(sProperty, data.defaultProject?.id, data.roui.domain));
                        } catch (e) {
                            reject(e.message);
                        }
                    } else if (count < 5) {
                        that.checkUntillFound(testFunction, callbackFunction, window);
                        count++;
                    } else {
                        reject("Unable to load the server configuration. Please try again later");
                    }
                }

                that.checkUntillFound(testFunction, callbackFunction, window);
            });
        },

        getRequestHeaders() {
            const roui = this.getModel().getProperty("/roui") || {};
            const sHeaders = {
                "Content-Type": "application/json"
            };
            if (roui.key) {
                sHeaders["Authorization"] = roui.key;
            }
            if (roui.email) {
                sHeaders["xu"] = roui.email;
            }
            return sHeaders;
        },

        /**
         * GET an API and put the response into a named model.
         *   this.loadDatatoViewwithKey_GET("usersAPI", "globalUsers", null, 1000);
         *   this.loadDatatoViewwithKey_GET("/users/list", "globalUsers");
         * Bind in the view with {globalUsers>/...}
         */
        loadDatatoViewwithKey_GET(sProperty, sView, callback, nSizeLimit) {
            const oView = this.getView();
            oView.setBusyIndicatorDelay(1);
            oView.setBusy(true);
            this.getApiCall_V2(sProperty).then((prop) => {
                const oModel = new JSONModel();
                oModel.attachRequestCompleted((oData) => {
                    oView.setBusy(false);
                    if (oData.getParameter("success")) {
                        this.setModelDataToCtrl(oModel.getData(), sView, oView, nSizeLimit);
                    } else {
                        this.messageBoxError(oData);
                    }
                    if (callback) {
                        callback(oModel);
                    }
                });
                oModel.loadData(prop, null, true, "GET", false, false, this.getRequestHeaders());
            }).catch((error) => {
                oView.setBusy(false);
                oView.setBusyIndicatorDelay(0);
                MessageBox.error(String(error));
            });
        },

        /**
         * POST a JSON payload to an API.
         *   this.loadData_POST("addProjectAPI", { name: "..." }, (oModel, bSuccess) => { ... });
         * callback gets the response model and a success flag; errors are shown in a MessageBox.
         * oBusyCtrl (optional) is set busy during the call instead of the whole view.
         */
        loadData_POST(sProperty, oInput, callback, oBusyCtrl) {
            this._sendData("POST", sProperty, oInput, callback, oBusyCtrl);
        },

        /**
         * DELETE via an API. Use replaceVars for the key in the URL:
         *   this.loadData_DELETE({ propertyName: "deleteProjectAPI", replaceVars: { id } }, (oModel, bSuccess) => { ... });
         */
        loadData_DELETE(sProperty, callback, oBusyCtrl) {
            this._sendData("DELETE", sProperty, null, callback, oBusyCtrl);
        },

        _sendData(sMethod, sProperty, oInput, callback, oBusyCtrl, bIsRetry) {
            const oBusy = oBusyCtrl || this.getView();
            oBusy.setBusyIndicatorDelay(0);
            oBusy.setBusy(true);
            Promise.all([this.getApiCall_V2(sProperty), this.getCsrfToken()]).then(([prop, sCsrfToken]) => {
                const oModel = new JSONModel();
                const oHeaders = this.getRequestHeaders();
                if (sCsrfToken) {
                    oHeaders["X-CSRF-Token"] = sCsrfToken;
                }
                oModel.attachRequestCompleted((oData) => {
                    oBusy.setBusy(false);
                    const nStatus = oData.getParameter("errorobject")?.statusCode;
                    // CSRF token expired (e.g. new session) - fetch a new one and retry once
                    if (nStatus === 403 && sCsrfToken && !bIsRetry) {
                        this.resetCsrfToken();
                        this._sendData(sMethod, sProperty, oInput, callback, oBusyCtrl, true);
                        return;
                    }
                    // 2xx with an empty body (e.g. 204 No Content) also counts as success
                    const bHttpOk = oData.getParameter("success") || (nStatus >= 200 && nStatus < 300);
                    const bSuccess = bHttpOk && oModel.getProperty("/success") !== false;
                    if (!bSuccess) {
                        this.messageBoxError(oData, oModel);
                    }
                    if (callback) {
                        callback(oModel, bSuccess);
                    }
                });
                oModel.loadData(prop, oInput ? JSON.stringify(oInput) : null, true, sMethod, false, false, oHeaders);
            }).catch((error) => {
                oBusy.setBusy(false);
                MessageBox.error(String(error));
            });
        },

        /**
         * CSRF token for POST/PUT/DELETE. Only needed on Cloud Foundry, where the approuter enforces it
         * (/appconfig returns roui.csrf = true); the local dev server needs none. Shared by all controllers.
         */
        getCsrfToken() {
            if (!this.getModel().getProperty("/roui/csrf")) {
                return Promise.resolve(null);
            }
            const oComponent = this.getOwnerComponent();
            if (!oComponent._pCsrfToken) {
                const sDomain = this.getModel().getProperty("/roui/domain");
                oComponent._pCsrfToken = fetch(sDomain + "/", {
                    method: "HEAD",
                    headers: { "X-CSRF-Token": "Fetch" },
                    credentials: "same-origin"
                }).then((oResponse) => oResponse.headers.get("X-CSRF-Token"))
                    .catch(() => null);
            }
            return oComponent._pCsrfToken;
        },

        resetCsrfToken() {
            this.getOwnerComponent()._pCsrfToken = null;
        },

        /**
         * Sets data on the named model of oCtrl (view or component), creating the model if needed.
         */
        setModelDataToCtrl(data, sModelName, oCtrl, nSizeLimit) {
            let oModel = oCtrl.getModel(sModelName);
            if (!oModel) {
                oModel = new JSONModel();
                oCtrl.setModel(oModel, sModelName);
            }
            if (nSizeLimit) {
                oModel.setSizeLimit(nSizeLimit);
            }
            oModel.setData(data);
            return oModel;
        },

        messageBoxError(oData, oModel) {
            const oParams = oData?.getParameters?.() || {};
            const oError = oParams.errorobject || {};
            // HTTP 200 with { success: false, message } - take the message from the response body
            let sMessage = oModel?.getProperty("/message") || oError.responseText || oError.statusText || "Request failed";
            try {
                const oJson = JSON.parse(sMessage);
                sMessage = oJson.message || oJson.error?.message || oJson.error || sMessage;
            } catch (e) {
                // not JSON - show as is
            }
            MessageBox.error(String(sMessage), {
                title: oError.statusCode ? `Error ${oError.statusCode}` : "Error"
            });
        }
    });
});
