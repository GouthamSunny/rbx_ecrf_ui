/* eslint-disable camelcase */
const approuter = require("@sap/approuter");
const jwtDecode = require("jwt-decode");
const rp = require("request-promise");
const xsenv = require("@sap/xsenv");
const log = require("cf-nodejs-logging-support");

// xsenv.loadEnv(); // Uncomment for local testing with default-env.json

// Configure logging
log.setLoggingLevel(process.env.LOG_LEVEL || "info");
log.info("Approuter starting with cf-nodejs-logging-support");

// Read services
const dest_service = xsenv.getServices({ dest: { tag: "destination" } }).dest;
const uaa_service = xsenv.getServices({ uaa: { tag: "xsuaa" } }).uaa;
const conn_service = xsenv.getServices({ conn: { tag: "connectivity" } }).conn;

const BACKEND_DEST_NAME = "backend";
const CLIENT_DEST_NAME = "client";

const sUaaCredentials = dest_service.clientid + ":" + dest_service.clientsecret;

const ar = approuter();

/**
 * Helper: get connectivity proxy info for OnPrem destinations.
 * Returns:
 *   null  -> destination is Internet
 *   { proxy, headers } -> for OnPrem via Cloud Connector
 */
function getOnPremProxyConfig(oDestination, logger) {
    const proxyType = oDestination.destinationConfiguration.ProxyType;

    if (proxyType !== "OnPremise") {
        logger.info(`Destination '${BACKEND_DEST_NAME}' with type: ${proxyType}`);
        return Promise.resolve(null);
    }

    logger.info("Preparing OnPremise connectivity configuration");

    const connCreds = conn_service;
    const connBasic = connCreds.clientid + ":" + connCreds.clientsecret;

    const tokenUrlBase = connCreds.token_service_url || connCreds.url;
    const tokenUrl = tokenUrlBase.replace(/\/$/, "") + "/oauth/token";

    return rp({
        uri: tokenUrl,
        method: "POST",
        headers: {
            Authorization: "Basic " + Buffer.from(connBasic).toString("base64"),
            "Content-type": "application/x-www-form-urlencoded"
        },
        form: {
            grant_type: "client_credentials"
        }
    }).then((data) => {
        const json = JSON.parse(data);
        const accessToken = json.access_token;

        const proxyHost = connCreds.onpremise_proxy_host;
        const proxyPort =
            connCreds.onpremise_proxy_http_port || connCreds.onpremise_proxy_port;

        logger.info(`The connectivity proxy resolved with host ${proxyHost} and port ${proxyPort}`);

        const proxyHeaders = {
            "Proxy-Authorization": "Bearer " + accessToken
        };

        const locationId =
            oDestination.destinationConfiguration.CloudConnectorLocationId ||
            oDestination.destinationConfiguration.cloudConnectorLocationId;

        if (locationId) {
            proxyHeaders["SAP-Connectivity-SCC-Location_ID"] = locationId;
        }

        return {
            proxy: "http://" + proxyHost + ":" + proxyPort,
            headers: proxyHeaders
        };
    });
}

/**
 * Generic backend caller with logging and status visibility.
 */
function callBackend(url, baseOptions, onPremProxyConfig, stepName, req) {
    const logger = req.logger || log;

    const options = Object.assign(
        {
            uri: url,
            resolveWithFullResponse: true,
            simple: false
        },
        baseOptions || {}
    );

    // propagate correlation id downstream
    const cid = logger.getCorrelationId && logger.getCorrelationId();
    options.headers = options.headers || {};
    if (cid) {
        options.headers["x-correlation-id"] = cid;
    }

    if (onPremProxyConfig) {
        options.proxy = onPremProxyConfig.proxy;
        options.headers["Proxy-Authorization"] =
            onPremProxyConfig.headers["Proxy-Authorization"];

        if (onPremProxyConfig.headers["SAP-Connectivity-SCC-Location_ID"]) {
            options.headers["SAP-Connectivity-SCC-Location_ID"] =
                onPremProxyConfig.headers["SAP-Connectivity-SCC-Location_ID"];
        }
    }

    logger.info(`Calling backend with URL '${url}' for step '${stepName}'.`);

    return rp(options).then((response) => {
        const status = response.statusCode;
        const location = response.headers && response.headers.location;

        logger.info(`Backend call finished with status ${status} for step ${stepName}`);

        if (status >= 200 && status < 300) {
            return response.body;
        }

        logger.error(`Backend call failed for step '${stepName}' with status '${status}' at location '${location}'.`);

        const err = new Error(`${stepName} failed with status ${status}`);
        err.statusCode = status;
        err.location = location;
        throw err;
    });
}

ar.beforeRequestHandler.use("/myinfo", (req, res) => {
    // Attach request logger & correlation/tenant context
    log.logNetwork(req, res);
    const logger = req.logger || log;

    // Correlation ID from CF/logger
    const correlationId = logger.getCorrelationId && logger.getCorrelationId();
    if (correlationId) {
        res.setHeader("x-correlation-id", correlationId);
    }

    let decoded;
    try {
        decoded = jwtDecode(req.user.token.accessToken);
    } catch (e) {
        logger.error(`Failed to decode JWT token. Error: '${e.message}'`);

    }

    // Tenant data (xsuaa standard claims)
    if (decoded && decoded.zid && logger.setTenantId) {
        logger.setTenantId(decoded.zid);
    }
    if (
        decoded &&
        decoded.ext_attr &&
        decoded.ext_attr.zdn &&
        logger.setTenantSubdomain
    ) {
        logger.setTenantSubdomain(decoded.ext_attr.zdn);
    }

    const email = decoded && decoded.email;
    const totalres = { roui: {}, correlationId };

    if (email) {
        totalres.roui.email = email;
    }
    logger.info(`Decoded Obj ${JSON.stringify(decoded)}`);
    logger.info(`Incoming /myinfo request from user ${email}`);

    if (!email) {
        res.statusCode = 500;
        res.end(
            JSON.stringify({
                error: "Failed to decode user token (no email)",
                correlationId
            })
        );
        return;
    }

    const hosturl = "https://" + req.headers.host;

    let destAccessToken;
    let backendDestination;
    let clientDestination;
    let backendProxyConfig = null;

    // 1. Get OAuth token for destination service
    const uaaTokenUrl = uaa_service.url.replace(/\/$/, "") + "/oauth/token";
    logger.info(`Requesting OAuth token from destination service using Token URL: ${uaaTokenUrl}`);

    rp({
        uri: uaaTokenUrl,
        method: "POST",
        headers: {
            Authorization: "Basic " + Buffer.from(sUaaCredentials).toString("base64"),
            "Content-type": "application/x-www-form-urlencoded"
        },
        form: {
            client_id: dest_service.clientid,
            grant_type: "client_credentials"
        }
    })
        // 2. Read backend destination configuration
        .then((data) => {
            const tokenJson = JSON.parse(data);
            destAccessToken = tokenJson.access_token;

            const backendDestUrl =
                dest_service.uri.replace(/\/$/, "") +
                "/destination-configuration/v1/destinations/" +
                BACKEND_DEST_NAME;
            logger.info(`Loading '${BACKEND_DEST_NAME}' destination details from URL: ${backendDestUrl}`);

            return rp({
                uri: backendDestUrl,
                headers: {
                    Authorization: "Bearer " + destAccessToken
                }
            });
        })
        .then((backendData) => {
            backendDestination = JSON.parse(backendData);

            const backendUrl = backendDestination.destinationConfiguration.URL;
            const proxyType = backendDestination.destinationConfiguration.ProxyType;

            logger.info(`Destination '${BACKEND_DEST_NAME}' Resolved with type: ${proxyType} and Destination Url: ${backendUrl}`,);

            if (proxyType === "OnPremise") {
                // Backend OnPrem:
                //  - use backend (via Cloud Connector) for /rateloginserver/authorization/apitoken
                //  - use client (Internet) for totalres.roui.domain
                const clientDestUrl =
                    dest_service.uri.replace(/\/$/, "") +
                    "/destination-configuration/v1/destinations/" +
                    CLIENT_DEST_NAME;
                logger.info(`The '${BACKEND_DEST_NAME}' destination uses 'OnPremise' proxy type and loading '${CLIENT_DEST_NAME}' destination from URL: ${clientDestUrl}`);

                return Promise.all([
                    getOnPremProxyConfig(backendDestination, logger),
                    rp({
                        uri: clientDestUrl,
                        headers: {
                            Authorization: "Bearer " + destAccessToken
                        }
                    })
                ]);
            } else {
                // Backend Internet → use backend URL as domain
                totalres.roui.domain = backendUrl;
                logger.info(`The '${BACKEND_DEST_NAME}' destination uses the 'Internet' proxy type with URL: ${totalres.roui.domain}.`);
                return null;
            }
        })
        .then((result) => {
            // If result != null, backend is OnPrem and we loaded client destination
            if (result) {
                backendProxyConfig = result[0];
                clientDestination = JSON.parse(result[1]);
                totalres.roui.domain = clientDestination.destinationConfiguration.URL;
                logger.info(`The '${CLIENT_DEST_NAME}' destination successfully resolved. Using URL: ${totalres.roui.domain}`);
            }

            // 3. Call backend login endpoint /rateloginserver/authorization/apitoken
            const backendBaseUrl =
                backendDestination.destinationConfiguration.URL.replace(/\/$/, "");
            const loginUrl =
                backendBaseUrl + "/rateloginserver/authorization/apitoken";

            return callBackend(
                loginUrl,
                {
                    method: "POST",
                    body: {
                        id: totalres.roui.email
                    },
                    headers: {
                        Origin: hosturl
                    },
                    json: true
                },
                backendProxyConfig, // only backend uses connectivity
                "login-apitoken",
                req
            );
        })
        // 4. Use authorization token to load projects (always via Internet domain)
        .then((loginResult) => {
            totalres.roui.key = loginResult.authorizationToken;

            const backendBaseUrlForProjects =
                backendDestination.destinationConfiguration.URL.replace(/\/$/, "");

            const projectsUrl = backendBaseUrlForProjects + "/saparate/projects/";

            // const projectsUrl =
            //     totalres.roui.domain.replace(/\/$/, "") + "/saparate/projects/";

            return callBackend(
                projectsUrl,
                {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: totalres.roui.key,
                        Origin: hosturl
                    }
                },
                backendProxyConfig, // null for Internet
                "projects",
                req
            );
        })
        // 5. Parse projects and call license/settings
        .then((projectsBody) => {
            const projects = JSON.parse(projectsBody);
            totalres.projects = projects;
            logger.info(`Projects loaded successfully. Total projects: ${Array.isArray(projects) ? projects.length : "not array"}`);

            const licenseUrl = backendDestination.destinationConfiguration.URL.replace(/\/$/, "") + "/saparate/client/settings/license";

            // const licenseUrl =
            //     totalres.roui.domain.replace(/\/$/, "") +
            //     "/saparate/client/settings/license";

            return callBackend(
                licenseUrl,
                {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: totalres.roui.key,
                        Origin: hosturl
                    }
                },
                backendProxyConfig, // null for Internet
                "license",
                req
            );
        })
        // 6. Parse menus and finish
        .then((licenseBody) => {
            const menus = JSON.parse(licenseBody);

            menus.typeMap = {};
            if (Array.isArray(menus.modules)) {
                for (let i = 0; i < menus.modules.length; i++) {
                    menus.typeMap[menus.modules[i].type] = menus.modules[i];
                }
            }
            totalres.menus = menus;
            logger.info("The /myinfo request completed successfully");

            res.end(JSON.stringify(totalres));
        })
        .catch((error) => {
            logger.error(`An error occurred while processing /myinfo. Message:${error?.message || error}, Status Code: ${error?.statusCode}, Location: ${error?.location}"`);

            res.statusCode = 500;
            res.end(
                JSON.stringify({
                    error: "Internal error while processing /myinfo",
                    correlationId,
                    details: error.message || error
                })
            );
        });
});

ar.beforeRequestHandler.use("/session", (req, res) => {
    log.logNetwork(req, res);
    const logger = req.logger || log;
    const correlationId = logger.getCorrelationId && logger.getCorrelationId();
    if (correlationId) {
        res.setHeader("x-correlation-id", correlationId);
    }
    logger.info("Processing /session request");
    res.end(JSON.stringify({ successes: true }));
});

ar.start();
log.info("Approuter started and listening");



// /* eslint-disable camelcase */
// const approuter = require("@sap/approuter");
// const jwtDecode = require("jwt-decode");
// const rp = require("request-promise");
// const xsenv = require("@sap/xsenv");
//
// // xsenv.loadEnv(); // uncomment for local testing with default-env.json
//
// // Read services
// const dest_service = xsenv.getServices({ dest: { tag: "destination" } }).dest;
// const uaa_service = xsenv.getServices({ uaa: { tag: "xsuaa" } }).uaa;
//
// // Connectivity service for Cloud Connector
// // Make sure your connectivity instance has tag "connectivity"
// const conn_service = xsenv.getServices({ conn: { tag: "connectivity" } }).conn;
//
// const sUaaCredentials = dest_service.clientid + ":" + dest_service.clientsecret;
// const sDestinationName = "backend";
//
// const ar = approuter();
//
// // Helper: get connectivity proxy info for OnPrem destinations
// const getOnPremProxyConfig = (oDestination) => {
//     // Only needed for OnPrem destinations
//     if (oDestination.destinationConfiguration.ProxyType !== "OnPremise") {
//         return Promise.resolve(null);
//     }
//
//     const connCreds = conn_service;
//     const connBasic = connCreds.clientid + ":" + connCreds.clientsecret;
//
//     const tokenUrlBase = connCreds.token_service_url || connCreds.url;
//     const tokenUrl = tokenUrlBase.replace(/\/$/, "") + "/oauth/token";
//
//     return rp({
//         uri: tokenUrl,
//         method: "POST",
//         headers: {
//             "Authorization": "Basic " + Buffer.from(connBasic).toString("base64"),
//             "Content-type": "application/x-www-form-urlencoded"
//         },
//         form: {
//             "grant_type": "client_credentials"
//             // resource parameter is optional for most cases
//         }
//     }).then((data) => {
//         const accessToken = JSON.parse(data).access_token;
//
//         const proxyHost = connCreds.onpremise_proxy_host;
//         const proxyPort =
//             connCreds.onpremise_proxy_http_port || connCreds.onpremise_proxy_port;
//
//         const proxy = "http://" + proxyHost + ":" + proxyPort;
//
//         const proxyHeaders = {
//             "Proxy-Authorization": "Bearer " + accessToken
//         };
//
//         // If you set a CloudConnectorLocationId on the destination, forward it
//         const locationId =
//             oDestination.destinationConfiguration.CloudConnectorLocationId ||
//             oDestination.destinationConfiguration.cloudConnectorLocationId;
//
//         if (locationId) {
//             proxyHeaders["SAP-Connectivity-SCC-Location_ID"] = locationId;
//         }
//
//         return {
//             proxy,
//             headers: proxyHeaders
//         };
//     });
// };
//
// ar.beforeRequestHandler.use("/myinfo", (req, res) => {
//     const totalres = { roui: {} }; // make it per request to avoid cross request data mix
//     const email = jwtDecode(req.user.token.accessToken).email;
//     totalres.roui.email = email;
//
//     const hosturl = "https://" + req.headers.host;
//
//     let oDestination;
//     let onPremProxyConfig = null;
//
//     // 1. Get access token for destination service
//     rp({
//         uri: uaa_service.url.replace(/\/$/, "") + "/oauth/token",
//         method: "POST",
//         headers: {
//             "Authorization": "Basic " + Buffer.from(sUaaCredentials).toString("base64"),
//             "Content-type": "application/x-www-form-urlencoded"
//         },
//         form: {
//             "client_id": dest_service.clientid,
//             "grant_type": "client_credentials"
//         }
//     })
//         // 2. Read destination configuration
//         .then((data) => {
//             const token = JSON.parse(data).access_token;
//             return rp({
//                 uri:
//                     dest_service.uri.replace(/\/$/, "") +
//                     "/destination-configuration/v1/destinations/" +
//                     sDestinationName,
//                 headers: {
//                     "Authorization": "Bearer " + token
//                 }
//             });
//         })
//         // 3. If ProxyType is OnPremise, prepare connectivity proxy information
//         .then((data) => {
//             oDestination = JSON.parse(data);
//             totalres.roui.domain = oDestination.destinationConfiguration.URL;
//
//             return getOnPremProxyConfig(oDestination);
//         })
//         .then((proxyConfig) => {
//             onPremProxyConfig = proxyConfig || null;
//
//             // 4. Call backend /rateloginserver/authorization/apitoken via destination
//             const options = {
//                 method: "POST",
//                 uri:
//                     oDestination.destinationConfiguration.URL.replace(/\/$/, "") +
//                     "/rateloginserver/authorization/apitoken",
//                 body: {
//                     id: email
//                 },
//                 headers: {
//                     "Origin": hosturl
//                 },
//                 json: true
//             };
//
//             if (onPremProxyConfig) {
//                 options.proxy = onPremProxyConfig.proxy;
//                 // add proxy headers without overwriting Origin
//                 options.headers["Proxy-Authorization"] =
//                     onPremProxyConfig.headers["Proxy-Authorization"];
//                 if (onPremProxyConfig.headers["SAP-Connectivity-SCC-Location_ID"]) {
//                     options.headers["SAP-Connectivity-SCC-Location_ID"] =
//                         onPremProxyConfig.headers["SAP-Connectivity-SCC-Location_ID"];
//                 }
//             }
//
//             return rp(options);
//         })
//         // 5. Use token to load projects
//         .then((result) => {
//             totalres.roui.key = result.authorizationToken;
//
//             const options = {
//                 uri:
//                     totalres.roui.domain.replace(/\/$/, "") +
//                     "/saparate/projects/",
//                 headers: {
//                     "Content-Type": "application/json",
//                     "Authorization": totalres.roui.key,
//                     "Origin": hosturl
//                 }
//             };
//
//             if (onPremProxyConfig) {
//                 options.proxy = onPremProxyConfig.proxy;
//                 options.headers["Proxy-Authorization"] =
//                     onPremProxyConfig.headers["Proxy-Authorization"];
//                 if (onPremProxyConfig.headers["SAP-Connectivity-SCC-Location_ID"]) {
//                     options.headers["SAP-Connectivity-SCC-Location_ID"] =
//                         onPremProxyConfig.headers["SAP-Connectivity-SCC-Location_ID"];
//                 }
//             }
//
//             return rp(options);
//         })
//         // 6. Load menus/license settings
//         .then((result) => {
//             totalres["projects"] = JSON.parse(result);
//
//             const options = {
//                 uri:
//                     totalres.roui.domain.replace(/\/$/, "") +
//                     "/saparate/client/settings/license",
//                 headers: {
//                     "Content-Type": "application/json",
//                     "Authorization": totalres.roui.key,
//                     "Origin": hosturl
//                 }
//             };
//
//             if (onPremProxyConfig) {
//                 options.proxy = onPremProxyConfig.proxy;
//                 options.headers["Proxy-Authorization"] =
//                     onPremProxyConfig.headers["Proxy-Authorization"];
//                 if (onPremProxyConfig.headers["SAP-Connectivity-SCC-Location_ID"]) {
//                     options.headers["SAP-Connectivity-SCC-Location_ID"] =
//                         onPremProxyConfig.headers["SAP-Connectivity-SCC-Location_ID"];
//                 }
//             }
//
//             return rp(options);
//         })
//         .then((result) => {
//             const menus = JSON.parse(result);
//             menus.typeMap = {};
//             for (let i = 0; i < menus.modules.length; i++) {
//                 menus.typeMap[menus.modules[i].type] = menus.modules[i];
//             }
//             totalres["menus"] = menus;
//             res.end(JSON.stringify(totalres));
//         })
//         .catch((error) => {
//             // you might want to log error.code, error.message etc.
//             res.statusCode = 500;
//             res.end(JSON.stringify({ error: error.message || error }));
//         });
// });
//
// ar.beforeRequestHandler.use("/session", (req, res) => {
//     res.end(JSON.stringify({ successes: true }));
// });
//
// ar.start();
//
//
//
//
// // /* eslint-disable camelcase */
// // const approuter = require("@sap/approuter");
// // const proxy = require("express-http-proxy");
// // const jwtDecode = require("jwt-decode");
// // let destinationObj = {};
// // const rp = require("request-promise");
// // const xsenv = require("@sap/xsenv");
// // const xssec = require("@sap/xssec");
// // const express = require("express");
// // const app = express();
// // //xsenv.loadEnv();
// // // const dest_service = xsenv.getServices({dest: {tag: "destination"}}).dest;
// // // const uaa_service = xsenv.getServices({uaa: {tag: "xsuaa"}}).uaa;
// // // const connection = xsenv.getServices({conn: {tag: "connectivity"}}).conn;
// //
// // // const sUaaCredentials = dest_service.clientid + ":" + dest_service.clientsecret;
// // //
// // //
// // // const conCredentials = connection.clientid + ":" + connection.clientsecret;
// //
// // const services = xsenv.getServices({
// //     conn: { tag: "connectivity" },
// //     dest: { tag: "destination" },
// //     uaa: { tag: "xsuaa" }
// // });
// // const sUaaCredentials = services.dest.clientid + ":" + services.dest.clientsecret;
// // const conCredentials = services.conn.clientid + ":" + services.conn.clientsecret;
// //
// //
// //
// //
// // const passport = require("passport");
// // passport.use("JWT", new xssec.JWTStrategy(services.uaa));
// // app.use(passport.initialize());
// // app.use(passport.authenticate("JWT", {
// //     session: false
// // }));
// //
// // const sDestinationName = "backend";
// // const totalres = {};
// // totalres["roui"] = {};
// // const ar = approuter();
// // // ar.beforeRequestHandler.use("/myinfo", (req, res) => {
// // //     const email = jwtDecode(req.user.token.accessToken).email;
// // //     totalres.roui.email = email;
// // //     const hosturl = "https://" + req.headers.host;
// // //     console.log("HostUrl", hosturl);
// // //     console.log("sUaaCredentials", sUaaCredentials);
// // //     console.log("dest_service", dest_service);
// // //     console.log("uaa_service", uaa_service);
// // //     console.log("Ro cc connection", JSON.stringify(connection));
// // //     // var hosturl = "https://rodev-dev-ro-ui.cfapps.eu10.hana.ondemand.com";
// // //     return rp({
// // //         uri: uaa_service.url + "/oauth/token",
// // //         method: "POST",
// // //         headers: {
// // //             "Authorization": "Basic " + Buffer.from(sUaaCredentials).toString("base64"),
// // //             "Content-type": "application/x-www-form-urlencoded"
// // //         },
// // //         form: {
// // //             "client_id": dest_service.clientid,
// // //             "grant_type": "client_credentials"
// // //         }
// // //     }).then((data) => {
// // //         console.log("data", data);
// // //         console.log("sDestinationName", sDestinationName);
// // //         const token = JSON.parse(data).access_token;
// // //         return rp({
// // //             uri: dest_service.uri + "/destination-configuration/v1/destinations/" + sDestinationName,
// // //             headers: {
// // //                 "Authorization": "Bearer " + token
// // //             }
// // //         });
// // //     }).then((data) => {
// // //         console.log("Destination data", data);
// // //         const oDestination = JSON.parse(data);
// // //         totalres.roui.domain = oDestination.destinationConfiguration.URL;
// // //         console.log("URL", oDestination.destinationConfiguration.URL);
// // //         return rp({
// // //             method: "POST",
// // //             uri: oDestination.destinationConfiguration.URL + "/rateloginserver/authorization/apitoken",
// // //             body: {
// // //                 id: email
// // //             },
// // //             headers: {
// // //                 "Authorization": "Basic " + Buffer.from(conCredentials).toString("base64"),
// // //                 "Proxy-Authorization": "Bearer " + JSON.parse(data).access_token;
// // //                 "Origin": hosturl,
// // //                 "SAP-Connectivity-SCC-Location_ID": "Srikanth"
// // //             },
// // //             json: true,
// // //             proxy: `http://${connection.onpremise_proxy_host}:${connection.onpremise_proxy_http_port}`,
// // //             strictSSL: false
// // //         });
// // //     }).then((result) => {
// // //         console.log("result", result);
// // //         totalres.roui.key = result.authorizationToken;
// // //         return rp({
// // //             uri: totalres.roui.domain + "/saparate/projects/",
// // //             headers: {
// // //                 "Content-Type": "application/json",
// // //                 "Authorization": totalres.roui.key,
// // //                 "Origin": hosturl
// // //             }
// // //         });
// // //     }).then((result) => {
// // //         console.log("Project result", result);
// // //         totalres["projects"] = JSON.parse(result);
// // //         return rp({
// // //             uri: totalres.roui.domain + "/saparate/client/settings/license",
// // //             headers: {
// // //                 "Content-Type": "application/json",
// // //                 "Authorization": totalres.roui.key,
// // //                 "Origin": hosturl
// // //             }
// // //         });
// // //     }).then((result) => {
// // //         console.log("license result", result);
// // //         let menus = JSON.parse(result);
// // //         menus.typeMap = {};
// // //         for ( let i = 0; i < menus.modules.length; i++ ) {
// // //             menus.typeMap[menus.modules[i].type] = menus.modules[i];
// // //         }
// // //         totalres["menus"] = menus;
// // //         res.end(JSON.stringify(totalres));
// // //     }).catch((error) => {
// // //         console.log("error", error);
// // //         res.end(JSON.stringify(error));
// // //     });
// // // });
// //
// //
// // app.use("/myinfo", proxy(services.conn.onpremise_proxy_host + ":" + services.conn.onpremise_proxy_http_port, {
// //
// //
// //         proxyReqOptDecorator: function (proxyReqOpts, srcReq) {
// //             "use strict";
// //             // eslint-disable-next-line no-console
// //             console.log("SUBDOMAIN: " + srcReq.authInfo.getSubdomain());
// //             return rp({
// //                 uri: "https://" + srcReq.authInfo.getSubdomain() + "." + services.dest.uaadomain + "/oauth/token?grant_type=client_credentials",
// //                 method: "POST",
// //                 headers: {
// //                     "Authorization": "Basic " + Buffer.from(sUaaCredentials).toString("base64")
// //                 }
// //             }).then((data) => {
// //                 const token = JSON.parse(data).access_token;
// //                 // console.log("TOKEN: " + token);
// //                 return rp({
// //                     uri: `${services.dest.uri}/destination-configuration/v1/destinations/${sDestinationName}`,
// //                     headers: {
// //                         "Authorization": "Bearer " + token
// //                     }
// //                 });
// //             }).then((data) => {
// //                 destinationObj = data;
// //                 // console.log("DESTINATION-OBJ: " + JSON.stringify(destinationObj));
// //                 return rp({
// //                     uri: "https://" + srcReq.authInfo.getSubdomain() + "." + services.conn.token_service_domain + "/oauth/token?grant_type=client_credentials&response_type=token",
// //                     headers: {
// //                         "Authorization": "Basic " + Buffer.from(conCredentials).toString("base64")
// //                     }
// //                 });
// //             }).then((data) => {
// //                 const token = JSON.parse(data).access_token;
// //                 const oDestination = JSON.parse(destinationObj);
// //                 proxyReqOpts.headers["Proxy-Authorization"] = "Bearer " + token;
// //                 proxyReqOpts.headers["SAP-Connectivity-SCC-Location_ID"] = oDestination.destinationConfiguration.CloudConnectorLocationId;
// //                 // console.log("DESTINATION: " + JSON.stringify(oDestination));
// //                 if (oDestination.destinationConfiguration.Authentication === "NoAuthentication" && proxyReqOpts.headers["x-authtoken"]) {
// //                     // console.log("X-AUTHTOKEN: " + proxyReqOpts.headers["x-authtoken"]);
// //                     proxyReqOpts.headers["Authorization"] = proxyReqOpts.headers["x-authtoken"];
// //                 } else if (oDestination.authTokens[0].http_header.value) {
// //                     proxyReqOpts.headers["Authorization"] = oDestination.authTokens ? oDestination.authTokens[0].http_header.value : "";
// //                 } else {
// //                     //TODO: check what to do.
// //                 }
// //                 //console.log("Authorization: " + proxyReqOpts.headers['Authorization']);
// //                 return proxyReqOpts;
// //
// //             });
// //         }
// //     }
// // ));
// //
// //
// // ar.beforeRequestHandler.use("/session", (req, res) => {
// //     res.end(JSON.stringify({"successes": true}));
// // });
// // ar.start();
