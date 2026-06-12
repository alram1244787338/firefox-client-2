# firefox-client
`firefox-client` is a [node](nodejs.org) library for remote debugging Firefox. You can use it to make things like [fxconsole](https://github.com/harthur/fxconsole), a remote JavaScript REPL.

```javascript
var FirefoxClient = require("firefox-client");

var client = new FirefoxClient();

client.connect(6000, function() {
  client.listTabs(function(err, tabs) {
    console.log("first tab:", tabs[0].url);
  });
});
```

## Install
With [node.js](http://nodejs.org/) npm package manager:

```bash
npm install firefox-client
```

## Connecting

### Desktop Firefox
1. Enable remote debugging (You'll only have to do this once)
 1. Open the DevTools. **Web Developer** > **Toggle Tools**
 2. Visit the settings panel (gear icon)
 3. Check "Enable remote debugging" under Advanced Settings

2. Listen for a connection
 1. Open the Firefox command line with **Tools** > **Web Developer** > **Developer Toolbar**.
 2. Start a server by entering this command: `listen 6000` (where `6000` is the port number)

### Firefox for Android
Follow the instructions in [this Hacks video](https://www.youtube.com/watch?v=Znj_8IFeTVs)

### Firefox OS 1.1 Simulator
A limited set of the API (`Console`, `StyleSheets`) is compatible with the [Simulator 4.0](https://addons.mozilla.org/en-US/firefox/addon/firefox-os-simulator/). See the [wiki instructions](https://github.com/harthur/firefox-client/wiki/Firefox-OS-Simulator-Instructions) for connecting.

`client.listTabs()` will list the currently open apps in the Simulator.

### Firefox OS 1.2+ Simulator and devices

`client.getWebapps()` will expose the webapps in the Simulator, where each app implements the `Tab` API.

```
client.getWebapps(function(err, webapps) {
  webapps.getApp("app://homescreen.gaiamobile.org/manifest.webapp", function (err, app) {
    console.log("homescreen:", actor.url);
    app.Console.evaluateJS("alert('foo')", function(err, resp) {
      console.log("alert dismissed");
    });
  });
});
```

## Compatibility

This latest version of the library will stay compatible with [Firefox Nightly](http://nightly.mozilla.org/). Almost all of it will be compatible with [Firefox Aurora](http://www.mozilla.org/en-US/firefox/aurora/) as well.

## API

A `FirefoxClient` is the entry point to the API. After connecting, get a `Tab` object with `listTabs()` or `selectedTab()`. Once you have a `Tab`, you can call methods and listen to events from the tab's modules, `Console` or `Network`. There are also experimental `DOM` and `StyleSheets` tab modules, and a `Debugger` module.

#### Methods
Almost all API calls take a callback that will get called with an error as the first argument (or `null` if there is no error), and a return value as the second:

```javascript
tab.Console.evaluateJS("6 + 7", function(err, resp) {
  if (err) throw err;

  console.log(resp.result);
});
```

#### Events

The modules are `EventEmitter`s, listen for events with `on` or `once`, and stop listening with `off`:

```javascript
tab.Console.on("page-error", function(event) {
  console.log("new error from tab:", event.errorMessage);
});
```

Summary of the offerings of the modules and objects:

#### [FirefoxClient](http://github.com/harthur/firefox-client/wiki/FirefoxClient)
Methods: `connect()`, `disconnect()`, `listTabs()`, `selectedTab()`, `getWebapps()`, `getRoot()`

Events: `"error"`, `"timeout"`, `"end"`

#### [Tab](https://github.com/harthur/firefox-client/wiki/Tab)
Properties: `url`, `title`

Methods: `reload()`, `navigateTo()`, `attach()`, `detach()`

Events: `"navigate"`, `"before-navigate"`

#### [Tab.Console](https://github.com/harthur/firefox-client/wiki/Console)
Methods: `evaluateJS()`, `startListening()`, `stopListening()`, `getCachedLogs()`

Events: `"page-error"`, `"console-api-call"`

#### [JSObject](https://github.com/harthur/firefox-client/wiki/JSObject)
Properties: `class`, `name`, `displayName`

Methods: `ownPropertyNames()`, `ownPropertyDescriptor()`, `ownProperties()`, `prototype()`

#### [Tab.Network](https://github.com/harthur/firefox-client/wiki/Network)
Methods: `startLogging()`, `stopLogging()`, `sendHTTPRequest()`

Events: `"network-event"`

#### [NetworkEvent](https://github.com/harthur/firefox-client/wiki/NetworkEvent)
Properties: `url`, `method`, `isXHR`

Methods: `getRequestHeaders()`, `getRequestCookies()`, `getRequestPostData()`, `getResponseHeaders()`, `getResponseCookies()`, `getResponseContent()`, `getEventTimings()`

Events: `"request-headers"`, `"request-cookies"`, `"request-postdata"`, `"response-start"`, `"response-headers"`, `"response-cookies"`, `"event-timings"`

#### [Tab.DOM](https://github.com/harthur/firefox-client/wiki/DOM)
Methods: `document()`, `documentElement()`, `querySelector()`, `querySelectorAll()`

#### [DOMNode](https://github.com/harthur/firefox-client/wiki/DOMNode)
Properties: `nodeValue`, `nodeName`, `namespaceURI`

Methods: `parentNode()`, `parents()`, `siblings()`, `nextSibling()`, `previousSibling()`, `querySelector()`, `querySelectorAll()`, `innerHTML()`, `outerHTML()`, `setAttribute()`, `remove()`, `release()`

#### [Tab.StyleSheets](https://github.com/harthur/firefox-client/wiki/StyleSheets)
Methods: `getStyleSheets()`, `addStyleSheet()`

#### [StyleSheet](https://github.com/harthur/firefox-client/wiki/StyleSheet)
Properties: `href`, `disabled`, `ruleCount`

Methods: `getText()`, `update()`, `toggleDisabled()`, `getOriginalSources()`

Events: `"disabled-changed"`, `"ruleCount-changed"`

#### Tab.Memory
Methods: `measure()`

#### Tab.Debugger
Methods: `attach()`, `detach()`, `pause()`, `resume()`, `stepOver()`, `stepIn()`, `stepOut()`, `getSources()`, `getFrames()`, `setBreakpoint()`

Events: `"pause"`, `"resume"`, `"new-source"`, `"new-global"`

```javascript
var dbg = tab.Debugger;

// get notified every time execution stops (breakpoint, step, or pause())
dbg.on("pause", function(info) {
  var frame = info.frame;
  console.log("paused (" + info.why.type + ") in",
              frame.functionName || "(top level)",
              "at", frame.url + ":" + frame.line + ":" + frame.column);

  // step over one line, then keep going
  dbg.stepOver(function(err) { if (err) throw err; });
});

// attaching leaves the thread paused, so resume() to let the page run
dbg.attach(function(err, paused) {
  if (err) throw err;

  dbg.getSources(function(err, sources) {
    if (err) throw err;
    // set a breakpoint on the first line of the first script
    sources[0].setBreakpoint({ line: 1 }, function(err, bp) {
      dbg.resume();
    });
  });
});
```

The `"pause"` and `"resume"` events fire for *unsolicited* stops (e.g. a
breakpoint is hit, or a step completes). Stops you ask for directly —
`attach()`, `pause()` — report their location through their own callback
instead, so you don't get the same stop twice.

#### Frame
A single entry in the call stack at a pause.

Properties: `type`, `url`, `line`, `column`, `functionName`, `depth`, `args`, `receiver`, `where`

#### Source
A script known to the debugger.

Properties: `url`, `introductionType`, `sourceMapURL`

Methods: `getText()`, `setBreakpoint()`

#### Webapps
Methods: `listRunningApps()`, `getInstalledApps()`, `watchApps()`, `unwatchApps()`, `launch()`, `close()`, `getApp()`, `installHosted()`, `installPackaged()`, `installPackagedWithADB()`, `uninstall()`

Events: `"appOpen"`, `"appClose"`, `"appInstall"`, `"appUninstall"`

## Examples

[fxconsole](https://github.com/harthur/fxconsole) - a remote JavaScript console for Firefox

[webapps test script](https://pastebin.mozilla.org/5094843) - a sample usage of all webapps features

## Feedback

What do you need from the API? [File an issue](https://github.com/harthur/firefox-client/issues/new).
