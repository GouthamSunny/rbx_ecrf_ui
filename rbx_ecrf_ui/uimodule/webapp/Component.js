sap.ui.define([
    "sap/ui/core/UIComponent",
    "sap/ui/model/json/JSONModel",
    "rbx/ecrf/uimodule/model/models"
], function (UIComponent, JSONModel, models) {
    "use strict";

    return UIComponent.extend("rbx.ecrf.uimodule.Component", {
        metadata: {
            manifest: "json",
            interfaces: ["sap.ui.core.IAsyncContentCreation"]
        },

        init: function () {
            UIComponent.prototype.init.apply(this, arguments);

            this.setModel(models.createDeviceModel(), "device");

            // Logged-in user (loaded by the dev server at startup) - bind with {userDetails>/first_name}
            const oUserDetails = new JSONModel({});
            this.setModel(oUserDetails, "userDetails");
            this.getModel().dataLoaded().then(() => {
                oUserDetails.setData(this.getModel().getProperty("/user") || {});
            });

            this.getRouter().initialize();
        }
    });
});
