// A tiny mock of a Firefox remote-debugging server. It speaks the same
// length-prefixed JSON protocol as lib/client.js (`<byteLen>:<json>`), sends the
// root greeting on connect, and replies to the requests issued by the
// Console / DOM / Network / StyleSheets wrappers with canned actor forms. It also
// pushes a few unsolicited events so the event paths can be exercised.
//
// This exists so the wrapper layer can be verified end-to-end without a real
// Firefox instance.

var net = require("net");

/* ---- actor ids ---- */
var ROOT = "root",
    CONSOLE = "console1",     // Tab.Console AND Tab.Network share the console actor
    INSPECTOR = "inspector1",
    STYLESHEETS = "stylesheets1",
    MEMORY = "memory1",
    WALKER = "walker1",
    NODELIST = "nodelist1",
    STYLE = "style1",
    NETEVENT = "netevent1";

/* ---- canned forms ---- */
var TAB = {
  actor: "tab1",
  title: "Mock Tab",
  url: "http://localhost/dom.html",
  consoleActor: CONSOLE,
  inspectorActor: INSPECTOR,
  styleSheetsActor: STYLESHEETS,
  memoryActor: MEMORY
};

function node(actor, nodeType, nodeName, attrs) {
  return {
    actor: actor,
    nodeType: nodeType,
    nodeName: nodeName,
    namespaceURI: "http://www.w3.org/1999/xhtml",
    attrs: attrs || []
  };
}
function idAttrs(id, cls) {
  var a = [{ name: "id", value: id }];
  if (cls) a.push({ name: "class", value: cls });
  return a;
}

var DOC_NODE = node("doc1", 9, "#document", []);
var HTML_NODE = node("html1", 1, "HTML", []);
var ITEM_NODES = [
  node("item1", 1, "DIV", idAttrs("test1", "item")),
  node("item2", 1, "DIV", idAttrs("test2", "item")),
  node("item3", 1, "DIV", idAttrs("test3", "item"))
];
var CHILD_NODES = [
  node("c1", 1, "DIV", idAttrs("child1")),
  node("c2", 1, "DIV", idAttrs("child2"))
];
var PARENT_NODES = [
  node("sec1", 1, "SECTION", []),
  node("main1", 1, "MAIN", []),
  node("body1", 1, "BODY", []),
  DOC_NODE
];
var WALKER_FORM = { actor: WALKER, root: node("rootnode", 9, "#document", []) };

var SS_TEXT = "main { color: black; }";
var SHEETS = [
  { actor: "sheet1", href: null, disabled: false, ruleCount: 1 },
  { actor: "sheet2", href: "http://localhost/stylesheet1.css", disabled: false, ruleCount: 2 }
];
var NEW_SHEET = { actor: "sheet3", href: null, disabled: false, ruleCount: 1 };
// per-connection disabled state is reset on connect (see below)

var NETEVENT_FORM = {
  actor: NETEVENT,
  url: "http://localhost/test-network.json",
  method: "GET",
  isXHR: true
};

var CACHED_MESSAGES = [
  {
    level: "log",
    filename: "mock.js",
    lineNumber: 2,
    arguments: ["cached", { type: "object", actor: "argobj2", class: "Array" }]
  }
];
var CONSOLE_API_EVENT = {
  from: CONSOLE,
  type: "consoleAPICall",
  message: {
    level: "log",
    filename: "mock.js",
    lineNumber: 1,
    arguments: ["hello", { type: "object", actor: "argobj1", class: "Object" }]
  }
};
var NETWORK_EVENT = { from: CONSOLE, type: "networkEvent", eventActor: NETEVENT_FORM };

function evaluate(text) {
  var resp = { input: text, timestamp: Date.now() };
  if (/^\s*6\s*\+\s*7\s*$/.test(text)) {
    resp.result = 13;
  } else if (/window/.test(text)) {
    resp.result = true;
  } else if (/["']hello["']/.test(text)) {
    resp.result = "hello";
  } else if (/\{/.test(text)) {
    resp.result = { type: "object", actor: "evalobj1", class: "Object" };
  } else if (/blargh/.test(text)) {
    resp.exception = { type: "object", actor: "exc1", class: "Error" };
    resp.exceptionMessage = "ReferenceError: blargh is not defined";
  } else {
    resp.result = { type: "undefined" };
  }
  return resp;
}

/* ---- protocol framing (mirrors lib/client.js) ---- */
function frame(obj) {
  var str = JSON.stringify(obj);
  return Buffer.byteLength(str) + ":" + str;
}

function createMockServer() {
  return net.createServer(function(socket) {
    var incoming = Buffer.alloc(0);
    // per-connection stylesheet disabled state
    var sheetDisabled = { sheet1: false, sheet2: false, sheet3: false };

    function reply(from, extra) {
      socket.write(frame(Object.assign({ from: from }, extra)));
    }
    function event(obj) {
      socket.write(frame(obj));
    }

    // root greeting, what FirefoxClient.connect() waits for
    reply(ROOT, { applicationType: "browser", traits: {} });

    socket.on("data", function(data) {
      incoming = Buffer.concat([incoming, data]);
      var msg;
      while ((msg = readMessage()) !== null) {
        handle(msg);
      }
    });

    function readMessage() {
      var sep = incoming.toString().indexOf(":");
      if (sep < 0) return null;
      var count = parseInt(incoming.slice(0, sep));
      if (incoming.length - (sep + 1) < count) return null;
      incoming = incoming.slice(sep + 1);
      var packet = incoming.slice(0, count);
      incoming = incoming.slice(count);
      return JSON.parse(packet.toString());
    }

    function handle(msg) {
      var to = msg.to, type = msg.type;

      if (to === ROOT && type === "listTabs") {
        return reply(ROOT, { tabs: [TAB], selected: 0 });
      }

      if (to === TAB.actor) {
        // attach / detach / reload / navigateTo
        return reply(TAB.actor, {});
      }

      if (to === CONSOLE) {
        switch (type) {
          case "startListeners":
            reply(CONSOLE, {});
            if (msg.listeners && msg.listeners.indexOf("ConsoleAPI") >= 0) {
              setImmediate(function() { event(CONSOLE_API_EVENT); });
            }
            return;
          case "stopListeners":
            return reply(CONSOLE, {});
          case "clearMessagesCache":
            return reply(CONSOLE, {});
          case "getCachedMessages":
            return reply(CONSOLE, { messages: CACHED_MESSAGES });
          case "evaluateJS":
            reply(CONSOLE, evaluate(msg.text));
            if (/sendRequest/.test(msg.text)) {
              setImmediate(function() { event(NETWORK_EVENT); });
            }
            return;
          case "sendHTTPRequest":
            return reply(CONSOLE, { eventActor: NETEVENT_FORM });
        }
      }

      if (to === INSPECTOR) {
        if (type === "getWalker") return reply(INSPECTOR, { walker: WALKER_FORM });
        if (type === "getPageStyle") return reply(INSPECTOR, { pageStyle: { actor: STYLE } });
      }

      if (to === WALKER) {
        switch (type) {
          case "document": return reply(WALKER, { node: DOC_NODE });
          case "documentElement": return reply(WALKER, { node: HTML_NODE });
          case "querySelector":
            return reply(WALKER, { node: querySelect(msg.selector) });
          case "querySelectorAll":
            return reply(WALKER, { list: { actor: NODELIST, length: ITEM_NODES.length } });
          case "children": return reply(WALKER, { nodes: CHILD_NODES });
          case "parents": return reply(WALKER, { nodes: PARENT_NODES });
          case "siblings": return reply(WALKER, { nodes: ITEM_NODES });
          case "nextSibling": return reply(WALKER, { node: ITEM_NODES[2] });
          case "previousSibling": return reply(WALKER, { node: ITEM_NODES[0] });
          case "innerHTML": return reply(WALKER, { value: "<inner>" });
          case "outerHTML": return reply(WALKER, { value: "<outer>" });
          case "modifyAttributes": return reply(WALKER, {});
          case "highlight": return reply(WALKER, {});
          case "removeNode": return reply(WALKER, { nextSibling: ITEM_NODES[2] });
          case "releaseNode": return reply(WALKER, {});
        }
      }

      if (to === NODELIST && type === "items") {
        var start = msg.start || 0;
        var end = (msg.end != null) ? msg.end : ITEM_NODES.length;
        return reply(NODELIST, { nodes: ITEM_NODES.slice(start, end) });
      }

      if (to === STYLESHEETS) {
        if (type === "getStyleSheets") return reply(STYLESHEETS, { styleSheets: SHEETS });
        if (type === "addStyleSheet") return reply(STYLESHEETS, { styleSheet: NEW_SHEET });
      }

      if (sheetDisabled.hasOwnProperty(to)) {
        switch (type) {
          case "getText": return reply(to, { text: SS_TEXT });
          case "update": return reply(to, {});
          case "getOriginalSources": return reply(to, { originalSources: null });
          case "getMediaRules": return reply(to, { mediaRules: [] });
          case "toggleDisabled":
            sheetDisabled[to] = !sheetDisabled[to];
            var disabled = sheetDisabled[to];
            reply(to, { disabled: disabled });
            // the server also emits a propertyChange for the toggle
            setImmediate(function() {
              event({ from: to, type: "propertyChange", property: "disabled", value: disabled });
            });
            return;
        }
      }

      if (to === NETEVENT && type === "getRequestHeaders") {
        return reply(NETEVENT, {
          headers: [{ name: "test-header", value: "test-value" }],
          headersSize: 42
        });
      }

      if (to === MEMORY && type === "measure") {
        return reply(MEMORY, { jsObjects: 100, total: 200 });
      }

      // surface anything we forgot to handle, so the harness fails loudly
      reply(to, {
        error: "unrecognizedRequest",
        message: "mock server has no handler for '" + type + "' on '" + to + "'"
      });
    }

    function querySelect(selector) {
      if (!selector || selector === "blarg") return null;
      return ITEM_NODES[0];
    }
  });
}

module.exports = { createMockServer: createMockServer, frame: frame };
