sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/UIComponent",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox"
], (Controller, UIComponent, JSONModel, MessageBox) => {
    "use strict";

    return Controller.extend("rbx.ecrf.uimodule.controller.BaseController", {

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

        messageBoxError(oData) {
            const oParams = oData?.getParameters?.() || {};
            const oError = oParams.errorobject || {};
            let sMessage = oError.responseText || oError.statusText || "Request failed";
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
