sap.ui.define([
    "sap/ui/core/format/DateFormat"
], (DateFormat) => {
    "use strict";

    // Created on first use, not when the module loads - locale (CLDR) data may not be ready yet at load time
    let oDateTimeFormat = null;

    return {
        // "2026-07-30T14:49:44.795792+00:00" -> "Jul 30, 2026, 8:19:44 PM" (browser time zone)
        dateTime(sValue) {
            if (!sValue) {
                return "";
            }
            const oDate = new Date(sValue);
            if (isNaN(oDate.getTime())) {
                return sValue;
            }
            try {
                oDateTimeFormat = oDateTimeFormat || DateFormat.getDateTimeInstance({ style: "medium" });
                return oDateTimeFormat.format(oDate);
            } catch (e) {
                return oDate.toLocaleString();
            }
        },

        isNotBlank(sValue) {
            return typeof sValue === "string" && sValue.trim().length > 0;
        },

        initials(sFirstName, sLastName) {
            return ((sFirstName || "").charAt(0) + (sLastName || "").charAt(0)).toUpperCase();
        },

        address(...aParts) {
            return [...new Set(aParts.filter(Boolean))].join(", ");
        }
    };
});
