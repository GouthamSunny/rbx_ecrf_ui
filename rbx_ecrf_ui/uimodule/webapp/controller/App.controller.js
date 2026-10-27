sap.ui.define([
    "rbx/ecrf/uimodule/controller/BaseController",
    "sap/ui/core/Fragment"
], (BaseController, Fragment) => {
    "use strict";

    return BaseController.extend("rbx.ecrf.uimodule.controller.App", {

        formatLastLogin(sValue) {
            return sValue ? this.formatter.dateTime(sValue) : this.getResourceBundle().getText("never");
        },

        onAvatarPressed(oEvent) {
            const oAvatar = oEvent.getParameter("avatar");
            if (!this._pUserDetails) {
                this._pUserDetails = Fragment.load({
                    id: this.getView().getId(),
                    name: "rbx.ecrf.uimodule.view.fragments.UserDetails",
                    controller: this
                }).then((oPopover) => {
                    this.getView().addDependent(oPopover);
                    return oPopover;
                });
            }
            this._pUserDetails.then((oPopover) => {
                if (oPopover.isOpen()) {
                    oPopover.close();
                } else {
                    oPopover.openBy(oAvatar);
                }
            });
        }
    });
});
