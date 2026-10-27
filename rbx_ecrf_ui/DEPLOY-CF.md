# Deploying eCRF to SAP BTP Cloud Foundry (multitenant)

## How it works

```
Browser ──► approuter (rbx-ecrf-ui)  ── XSUAA login, scope $XSAPPNAME.User
              │
              ├── /appconfig  ─► email + tenant from the XSUAA token
              │                  ─► GET <backend>/users/get_by_email/{email}
              │                  ◄─ { roui: { domain: "/api", email, tenantId, ... }, user }
              │
              ├── /api/<path> ─► <backend destination>/<path>
              │                  headers xu=<email>, x-tenant-id=<zid> (always taken from the token)
              │
              ├── /resources  ─► "ui5" destination (SAPUI5 CDN)
              └── /*          ─► Fiori app from the HTML5 application repository
```

The UI code is the same as locally: `dev-server.js` serves the same `/appconfig` and `/api` contract.

| Folder / file        | Purpose |
|----------------------|---------|
| `mta.yaml`           | Modules (approuter, Fiori app, content deployer) and services |
| `xs-security.json`   | XSUAA: `User` scope + role collection `eCRF_User`, `Callback` scope for the SaaS registry |
| `approuter/`         | `@sap/approuter` + extension `server.js` (`/appconfig`, `/api`) |
| `uimodule/`          | Fiori app; `npm run build:cf` builds `dist/rbxecrfuimodule.zip` |
| `deployer/`          | HTML5 content deployer (build output only) |

Services: `xsuaa` (application, shared tenant mode), `saas-registry`, `destination`,
`connectivity`, `html5-apps-repo` (app-host + app-runtime).

## 1. Before the first deployment

In `mta.yaml` → `parameters`:

- **`provider_subdomain`** – subdomain of the provider subaccount
  (BTP cockpit → Subaccount → Overview → *Subdomain*). Subscriber URLs are built by replacing it.
- **`backend_url`** – backend server, written into the `backend` destination of the provider subaccount.
- `app_host` – host name part of the approuter URL (default `rbx-ecrf-ui`).

The `backend` destination is created with `TrustAll: true`, because the current backend uses a
self-signed certificate. Remove it once the backend has a trusted certificate.

## 2. Build and deploy (provider subaccount)

```bash
npm install -g mbt          # once
cf login -a https://api.cf.<region>.hana.ondemand.com
mbt build -p=cf -t mta_archives --mtar rbx-ecrf.mtar
cf deploy mta_archives/rbx-ecrf.mtar
```

Provider URL: `https://<provider_subdomain>-rbx-ecrf-ui.cfapps.<region>.hana.ondemand.com`

## 3. Subscribe a tenant (subscriber subaccount)

1. Subscriber subaccount → *Instances and Subscriptions* → *Create* → **eCRF**.
2. Map the subscriber's route to the approuter (once per subscriber; run in the provider space):
   ```bash
   cf map-route rbx-ecrf-ui cfapps.<region>.hana.ondemand.com \
       --hostname <subscriber-subdomain>-rbx-ecrf-ui
   ```
   The host name must be lowercase and at most 63 characters.
3. Subscriber subaccount → *Security* → *Role Collections* → assign **eCRF_User** to the users.
4. Open *Go to Application* in the subscription.

The logged-in user's email must exist in the backend (`/users/get_by_email/{email}`);
otherwise the app shows the error returned by `/appconfig`.

## Backend destination per tenant (optional)

By default every tenant uses the provider's `backend` destination
(`BACKEND_DESTINATION_PROVIDER_ONLY: "true"` in `mta.yaml`). To let each subscriber point to its own
backend, set it to `"false"` and create a `backend` destination in each subscriber subaccount; the
provider destination is used as a fallback.

## Local development

Unchanged: `npm run dev` (see `dev-server.config.json`).
