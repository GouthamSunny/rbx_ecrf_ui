"use strict";
/**
 * Application router for the eCRF Fiori app on SAP BTP Cloud Foundry (multitenant).
 *
 * Standard approuter features used (configured in xs-app.json / mta.yaml):
 *   - XSUAA login and the $XSAPPNAME.User scope check
 *   - multitenancy: TENANT_HOST_PATTERN + SaaS registry callbacks (/callback/v1.0/...)
 *   - serving the Fiori app from the HTML5 application repository
 *
 * Added here (same contract as dev-server.js, so the UI runs unchanged in both):
 *   GET /appconfig  - logged-in user's email + tenant from the XSUAA token, user details
 *                     loaded from the backend (<backend>/users/get_by_email/{email})
 *   /api/*          - proxied to the "backend" destination with the user's identity headers
 *
 * Logging: cf-nodejs-logging-support. Every step is logged at "info" level together with the
 * request's correlation id (search for it in Kibana / `cf logs rbx-ecrf-ui --recent`).
 * Level is set with CF_NODEJS_LOGGING_LEVEL (mta.yaml); the approuter's default would be "error".
 */
const approuter = require("@sap/approuter");
const log = require("cf-nodejs-logging-support");
const { decodeJwt, getDestination, alwaysProvider, subscriberFirst } = require("@sap-cloud-sdk/connectivity");
const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");

const LOG_LEVEL = process.env.CF_NODEJS_LOGGING_LEVEL || "info";
const BACKEND_DESTINATION = process.env.BACKEND_DESTINATION || "backend";
const USER_API_PATH = process.env.USER_API_PATH || "/users/get_by_email/{email}";
const PROVIDER_ONLY = process.env.BACKEND_DESTINATION_PROVIDER_ONLY !== "false";
const API_PREFIX = "/api";

// Request headers passed on from the browser to the backend - everything else (cookies, ...) is dropped
const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "content-type", "if-none-match", "if-modified-since"];
// Response headers passed back to the browser
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-disposition", "etag", "last-modified", "x-file-name"];

log.setLoggingLevel(LOG_LEVEL);
log.info(`eCRF approuter starting (log level: ${LOG_LEVEL})`);
log.info(`Configuration: backend destination '${BACKEND_DESTINATION}', user API '${USER_API_PATH}', ` +
    `destination lookup '${PROVIDER_ONLY ? "provider subaccount only" : "subscriber first, then provider"}', ` +
    `TENANT_HOST_PATTERN '${process.env.TENANT_HOST_PATTERN || "(not set - single tenant)"}'`);
logBoundServices();

const ar = approuter();


/**
 * Logs which services are bound (names and plans only - never credentials).
 */
function logBoundServices() {
    try {
        const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
        const services = Object.keys(vcap).map((label) =>
            vcap[label].map((s) => `${s.name} (${label}/${s.plan})`).join(", "));
        log.info(`Bound services: ${services.length ? services.join(", ") : "none (running locally?)"}`);
    } catch (e) {
        log.warn(`Could not read VCAP_SERVICES: ${e.message}`);
    }
}

/**
 * Per-request logger. The approuter already calls logNetwork() for every request, so req.logger
 * carries the correlation id; the module logger is the fallback (e.g. local tests).
 */
function getLogger(req) {
    return req.logger || log;
}

function getCorrelationId(logger) {
    return logger.getCorrelationId ? logger.getCorrelationId() : undefined;
}

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
}

/**
 * Logged-in user from the XSUAA token (validated by the approuter before this runs).
 * Adds tenant id / subdomain to the request logger so they appear in every following log line.
 */
function getUserContext(req, logger) {
    const token = req.user && req.user.token && req.user.token.accessToken;
    if (!token) {
        throw httpError(401, "Not authenticated");
    }
    const claims = decodeJwt(token);
    const ctx = {
        token,
        email: claims.email,
        tenantId: claims.zid,
        subdomain: claims.ext_attr && claims.ext_attr.zdn,
        userName: claims.user_name,
        origin: claims.origin
    };
    if (ctx.tenantId && logger.setTenantId) {
        logger.setTenantId(ctx.tenantId);
    }
    if (ctx.subdomain && logger.setTenantSubdomain) {
        logger.setTenantSubdomain(ctx.subdomain);
    }
    logger.info(`User from XSUAA token: email '${ctx.email || "-"}', user '${ctx.userName || "-"}', ` +
        `identity provider '${ctx.origin || "-"}', tenant '${ctx.tenantId || "-"}', subdomain '${ctx.subdomain || "-"}'`);
    if (!ctx.email) {
        throw httpError(403, "The XSUAA token has no email - check the identity provider configuration");
    }
    return ctx;
}

/**
 * Reads the backend destination for the user's tenant from the Destination service (cached by the SDK).
 */
async function getBackendDestination(ctx, logger) {
    const strategy = PROVIDER_ONLY ? "provider subaccount" : "subscriber subaccount first";
    logger.info(`Fetching destination '${BACKEND_DESTINATION}' from the Destination service (${strategy})`);
    const destination = await getDestination({
        destinationName: BACKEND_DESTINATION,
        jwt: ctx.token,
        selectionStrategy: PROVIDER_ONLY ? alwaysProvider : subscriberFirst,
        useCache: true
    });
    if (!destination || !destination.url) {
        throw httpError(502, `Destination '${BACKEND_DESTINATION}' not found in the Destination service`);
    }
    logger.info(`Destination '${BACKEND_DESTINATION}' resolved: URL '${destination.url}', ` +
        `proxy type '${destination.proxyType || "Internet"}', authentication '${destination.authentication || "NoAuthentication"}', ` +
        `trust all certificates '${!!destination.isTrustingAllCertificates}'`);
    return destination;
}

/**
 * Calls the backend for the current user and tenant.
 * Identity headers are always set from the token - values sent by the browser are ignored.
 */
async function callBackend(ctx, logger, step, { method, url, headers, data }) {
    const destination = await getBackendDestination(ctx, logger);
    const target = destination.url.replace(/\/+$/, "") + url;
    const correlationId = getCorrelationId(logger);

    logger.info(`[${step}] Sending ${method.toUpperCase()} ${target} with xu '${ctx.email}', ` +
        `x-tenant-id '${ctx.tenantId || "-"}'${data ? `, body ${data.length} bytes` : ""}`);
    const started = Date.now();
    const response = await executeHttpRequest(destination, {
        method,
        url,
        data,
        headers: Object.assign({}, headers, {
            "xu": ctx.email,
            "x-tenant-id": ctx.tenantId
        }, correlationId ? { "x-correlation-id": correlationId } : {}),
        responseType: "arraybuffer",
        validateStatus: () => true // pass backend errors (4xx/5xx) through to the UI
    }, { fetchCsrfToken: false });

    const size = response.data ? response.data.byteLength || response.data.length || 0 : 0;
    const message = `[${step}] Backend answered ${response.status} for ${method.toUpperCase()} ${target} ` +
        `in ${Date.now() - started} ms (${size} bytes)`;
    if (response.status >= 400) {
        logger.warn(`${message}: ${Buffer.from(response.data || "").toString("utf8").slice(0, 500)}`);
    } else {
        logger.info(message);
    }
    return response;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
        req.on("error", reject);
    });
}

function parseJson(buffer) {
    try {
        return JSON.parse(Buffer.from(buffer || "").toString("utf8"));
    } catch (e) {
        return null;
    }
}


// GET /appconfig - same response shape as dev-server.js: { roui: {...}, user: {...} }
ar.beforeRequestHandler.use("/appconfig", async function appConfig(req, res) {
    const logger = getLogger(req);
    logger.info(`GET /appconfig received from host '${req.headers.host}'`);
    try {
        const ctx = getUserContext(req, logger);
        const userPath = USER_API_PATH.replace("{email}", encodeURIComponent(ctx.email));

        logger.info(`Loading user '${ctx.email}' from the backend`);
        const response = await callBackend(ctx, logger, "load-user", {
            method: "get",
            url: userPath,
            headers: { accept: "application/json" }
        });
        const body = parseJson(response.data);
        if (response.status < 200 || response.status >= 300 || !body || body.success !== true || !body.data) {
            throw httpError(502, `Could not load user "${ctx.email}" from the backend ` +
                `(HTTP ${response.status}: ${(body && body.message) || "unexpected response"})`);
        }
        logger.info(`User '${ctx.email}' found in the backend: id '${body.data.id}', backend tenant '${body.data.tenant_id}', ` +
            `status '${body.data.status || "-"}'`);

        sendJson(res, 200, {
            roui: {
                domain: API_PREFIX,
                email: ctx.email,
                key: "",
                tenantId: ctx.tenantId,
                subdomain: ctx.subdomain,
                csrf: true
            },
            user: body.data
        });
        logger.info(`GET /appconfig completed for '${ctx.email}'`);
    } catch (error) {
        logger.error(`GET /appconfig failed (status ${error.status || 500}): ${error.message || error}`);
        sendJson(res, error.status || 500, {
            message: error.message || String(error),
            correlationId: getCorrelationId(logger)
        });
    }
});


// /api/<path> -> <backend destination>/<path>
ar.beforeRequestHandler.use(API_PREFIX, async function backendProxy(req, res) {
    const logger = getLogger(req);
    // req.url is the path after /api (the mount path is stripped), including the query string
    logger.info(`${req.method} ${API_PREFIX}${req.url} received`);
    try {
        const ctx = getUserContext(req, logger);
        const headers = {};
        FORWARDED_REQUEST_HEADERS.forEach((name) => {
            if (req.headers[name]) {
                headers[name] = req.headers[name];
            }
        });
        const data = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);

        const response = await callBackend(ctx, logger, "api", { method: req.method, url: req.url, headers, data });

        res.statusCode = response.status;
        FORWARDED_RESPONSE_HEADERS.forEach((name) => {
            if (response.headers[name]) {
                res.setHeader(name, response.headers[name]);
            }
        });
        res.setHeader("Cache-Control", "no-store");
        res.end(response.data ? Buffer.from(response.data) : undefined);
        logger.info(`${req.method} ${API_PREFIX}${req.url} completed with status ${response.status}`);
    } catch (error) {
        logger.error(`${req.method} ${API_PREFIX}${req.url} failed (status ${error.status || 502}): ${error.message || error}`);
        sendJson(res, error.status || 502, {
            message: error.status ? error.message
                : `Could not reach the backend destination "${BACKEND_DESTINATION}": ${error.message || error}`,
            correlationId: getCorrelationId(logger)
        });
    }
});


ar.start();
log.info("eCRF approuter started and listening");
