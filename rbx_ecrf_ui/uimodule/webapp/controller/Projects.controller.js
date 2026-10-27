sap.ui.define([
    "rbx/ecrf/uimodule/controller/BaseController",
    "sap/ui/core/Fragment",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
    "sap/m/MessageBox"
], (BaseController, Fragment, JSONModel, Filter, FilterOperator, MessageToast, MessageBox) => {
    "use strict";

    return BaseController.extend("rbx.ecrf.uimodule.controller.Projects", {

        onInit() {
            this.getView().setModel(new JSONModel({ name: "", description: "" }), "newProject");
            this.loadProjects();
        },

        loadProjects() {
            this.loadDatatoViewwithKey_GET("projectsAPI", "projects", null, 1000);
        },

        onSearch(oEvent) {
            const sQuery = oEvent.getParameter("newValue");
            const aFilters = sQuery
                ? [new Filter({
                    filters: [
                        new Filter("name", FilterOperator.Contains, sQuery),
                        new Filter("description", FilterOperator.Contains, sQuery)
                    ],
                    and: false
                })]
                : [];
            this.byId("projectsTable").getBinding("items").filter(aFilters);
        },

        _getAddProjectDialog() {
            if (!this._pAddProjectDialog) {
                this._pAddProjectDialog = Fragment.load({
                    id: this.getView().getId(),
                    name: "rbx.ecrf.uimodule.view.fragments.AddProject",
                    controller: this
                }).then((oDialog) => {
                    this.getView().addDependent(oDialog);
                    return oDialog;
                });
            }
            return this._pAddProjectDialog;
        },

        onAddProject() {
            this.getModel("newProject").setData({ name: "", description: "" });
            this._getAddProjectDialog().then((oDialog) => {
                oDialog.open();
            });
        },

        onAddProjectSave() {
            const oNewProject = this.getModel("newProject").getData();
            const sName = (oNewProject.name || "").trim();
            if (!sName) {
                return;
            }
            const sTenantId = this.getModel("userDetails").getProperty("/tenant_id");
            if (!sTenantId) {
                MessageBox.error(this.getResourceBundle().getText("noTenantId"));
                return;
            }
            const oPayload = {
                tenant_id: sTenantId,
                name: sName,
                description: (oNewProject.description || "").trim()
            };
            this._getAddProjectDialog().then((oDialog) => {
                this.loadData_POST("addProjectAPI", oPayload, (oModel, bSuccess) => {
                    if (!bSuccess) {
                        return; // error already shown - keep the dialog open so the user can fix it
                    }
                    oDialog.close();
                    MessageToast.show(this.getResourceBundle().getText("projectCreated", [sName]));
                    this.loadProjects();
                }, oDialog);
            });
        },

        onDeleteProject(oEvent) {
            const oProject = oEvent.getParameter("listItem").getBindingContext("projects").getObject();
            const oBundle = this.getResourceBundle();
            MessageBox.warning(oBundle.getText("deleteProjectConfirm", [oProject.name]), {
                title: oBundle.getText("deleteProjectTitle"),
                actions: [MessageBox.Action.DELETE, MessageBox.Action.CANCEL],
                emphasizedAction: MessageBox.Action.DELETE,
                onClose: (sAction) => {
                    if (sAction !== MessageBox.Action.DELETE) {
                        return;
                    }
                    this.loadData_DELETE({
                        propertyName: "deleteProjectAPI",
                        replaceVars: { id: encodeURIComponent(oProject.id) }
                    }, (oModel, bSuccess) => {
                        if (bSuccess) {
                            MessageToast.show(oBundle.getText("projectDeleted", [oProject.name]));
                            this.loadProjects();
                        }
                    }, this.byId("projectsTable"));
                }
            });
        },

        onAddProjectCancel() {
            this._getAddProjectDialog().then((oDialog) => oDialog.close());
        },

        onAddProjectAfterClose() {
            this.getModel("newProject").setData({ name: "", description: "" });
        }
    });
});
