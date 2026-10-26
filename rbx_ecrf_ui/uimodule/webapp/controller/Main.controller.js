sap.ui.define([
    "rbx/ecrf/uimodule/controller/BaseController",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast"
], function (BaseController, Filter, FilterOperator, MessageToast) {
    "use strict";

    return BaseController.extend("rbx.ecrf.uimodule.controller.Main", {

        onInit: function () {
            this.loadDatatoViewwithKey_GET("usersAPI", "globalUsers", (oModel) => {
                // eslint-disable-next-line no-console
                console.log("users/list response:", oModel.getData());
            }, 1000);
        },

        onSearch: function (oEvent) {
            const sQuery = oEvent.getParameter("newValue");
            const aFilters = sQuery
                ? [new Filter({
                    filters: [
                        new Filter("subjectId", FilterOperator.Contains, sQuery),
                        new Filter("formName", FilterOperator.Contains, sQuery),
                        new Filter("site", FilterOperator.Contains, sQuery)
                    ],
                    and: false
                })]
                : [];
            this.byId("formsTable").getBinding("items").filter(aFilters);
        },

        onItemPress: function (oEvent) {
            const oForm = oEvent.getSource().getBindingContext("forms").getObject();
            MessageToast.show(oForm.subjectId + " – " + oForm.formName);
        },

        formatStatusState: function (sStatus) {
            switch (sStatus) {
                case "Completed": return "Success";
                case "In Progress": return "Warning";
                case "Query Open": return "Error";
                default: return "None";
            }
        },

        formatUserStatusState: function (sStatus) {
            switch ((sStatus || "").toLowerCase()) {
                case "active": return "Success";
                case "inactive": return "Warning";
                case "blocked":
                case "deleted": return "Error";
                default: return "None";
            }
        }
    });
});
