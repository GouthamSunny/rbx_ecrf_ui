(
  function () {
    "use strict";
    const argv = require("minimist")(process.argv.slice(2));
    const path = require("path");
    const url = require("url");
    const request = require("request");
    const rp = require("request-promise-native");
    const fs = require("fs-extra");
    const express = require("express");
    const { exec } = require("child_process");
    const app = express();

    const totalres = {};
    totalres["roui"] = {};


    function readJSON(filePath) {
      const fileContents = fs.readFileSync(path.join(__dirname, filePath));
      return JSON.parse(fileContents);
    }
    const config = readJSON("dev-server.config.json");

    // Command-line flags override the config file: --port 9000 --webRoot ./other --no-open
    config.port = Number(argv.port || config.port || 8080);
    config.webRoot = path.resolve(__dirname, argv.webRoot || config.webRoot || "./uimodule/webapp");


    // Backend API server. The UI calls /api/<path> and this server forwards it to <backendUrl>/<path>,
    // so the browser only talks to one origin (no CORS setup needed on the backend).
    config.backendUrl = argv.backendUrl || config.backendUrl;
    const API_PREFIX = "/api";


    totalres.roui.domain = config.localserver || API_PREFIX ;
    totalres.roui.origin = config.sorigin || `http://localhost:${config.port}`;
    totalres.roui.email = config.userId || "gouthamsunny21@gmail.com" ;
    totalres.roui.key = config.authKey || "";


    app.set("port", config.port);


    // App config for the UI - loaded into the default model ({ roui: { domain, origin, email, key } })
    app.get("/appconfig", function (req, res) {
      res.set("Cache-Control", "no-store").json(totalres);
    });


    app.use(API_PREFIX, function (req, res) {
      if (!config.backendUrl) {
        return res.status(500).json({ message: "backendUrl is not set in dev-server.config.json" });
      }
      const target = config.backendUrl.replace(/\/+$/, "") + req.url;
      const headers = Object.assign({}, req.headers);
      delete headers.host;
      delete headers.origin;
      delete headers.referer;
      req.pipe(request({ url: target, method: req.method, headers: headers }))
        .on("error", function (err) {
          console.error(`API proxy error: ${req.method} ${target} -> ${err.message}`);
          if (!res.headersSent) res.status(502);
          res.end(JSON.stringify({ message: `Could not reach ${config.backendUrl} (${err.code || err.message})` }));
        })
        .pipe(res);
    });


    // UI5 runtime: /resources and /test-resources.
    // Served from ui5.localPath if a local SAPUI5 copy exists there, otherwise proxied to the SAP CDN.
    const ui5 = config.ui5 || {};
    const ui5LocalPath = ui5.localPath && path.resolve(__dirname, ui5.localPath);
    const ui5CdnBase = new url.URL((ui5.version || "") + "/", ui5.url || "https://sapui5.hana.ondemand.com/").href;
    const hasLocalUi5 = Boolean(ui5LocalPath && fs.existsSync(path.join(ui5LocalPath, "resources")));

    ["/resources", "/test-resources"].forEach(function (mount) {
      if (hasLocalUi5) {
        app.use(mount, express.static(path.join(ui5LocalPath, mount)));
        return;
      }
      app.use(mount, function (req, res) {
        const target = new url.URL(mount.slice(1) + req.url, ui5CdnBase).href;
        request({ url: target, gzip: true })
          .on("error", function (err) {
            console.error(`UI5 proxy error: ${target} -> ${err.message}`);
            if (!res.headersSent) res.status(502);
            res.end(`Could not load ${target}`);
          })
          .pipe(res);
      });
    });


    // The Fiori app itself
    app.use(express.static(config.webRoot, { index: "index.html" }));

    app.use(function (req, res) {
      res.status(404).send(`Not found: ${req.originalUrl}`);
    });


    function openBrowser(target) {
      const cmd = process.platform === "win32" ? `start "" "${target}"`
        : process.platform === "darwin" ? `open "${target}"`
        : `xdg-open "${target}"`;
      exec(cmd, function (err) {
        if (err) console.log(`  Open ${target} in your browser.`);
      });
    }


    const server = app.listen(app.get("port"), function () {
      const appUrl = `http://localhost:${app.get("port")}/index.html`;
      console.log("");
      console.log(`  Fiori app running at  ${appUrl}`);
      console.log(`  Web root              ${config.webRoot}`);
      console.log(`  UI5 resources         ${hasLocalUi5 ? ui5LocalPath : ui5CdnBase}`);
      console.log("");
      if (argv.open !== false) openBrowser(appUrl);
    });

    server.on("error", function (err) {
      if (err.code === "EADDRINUSE") {
        console.error(`Port ${config.port} is already in use. Try: node dev-server.js --port 9000`);
      } else {
        console.error(err);
      }
      process.exit(1);
    });

  }
)();
