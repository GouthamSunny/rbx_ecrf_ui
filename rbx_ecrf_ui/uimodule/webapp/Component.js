sap.ui.define([
    "sap/ui/core/UIComponent",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "rbx/ecrf/uimodule/model/models"
], function (UIComponent, JSONModel, MessageBox, models) {
    "use strict";

    return UIComponent.extend("rbx.ecrf.uimodule.Component", {
        metadata: {
            manifest: "json",
            interfaces: ["sap.ui.core.IAsyncContentCreation"]
        },

        init: function () {
            UIComponent.prototype.init.apply(this, arguments);

            this.setModel(models.createDeviceModel(), "device");

            // Logged-in user from /appconfig (dev server locally, approuter on Cloud Foundry)
            // - bind with {userDetails>/first_name}
            const oUserDetails = new JSONModel({});
            this.setModel(oUserDetails, "userDetails");
            this.getModel().attachRequestFailed((oEvent) => {
                const sResponse = oEvent.getParameter("responseText") || "";
                let sMessage = oEvent.getParameter("message") || "Could not load the application configuration";
                try {
                    sMessage = JSON.parse(sResponse).message || sMessage;
                } catch (e) {
                    // not JSON
                }
                MessageBox.error(sMessage, { title: "eCRF" });
            });
            this.getModel().dataLoaded().then(() => {
                oUserDetails.setData(this.getModel().getProperty("/user") || {});
            });

            this.getRouter().initialize();
        }
    });
});
