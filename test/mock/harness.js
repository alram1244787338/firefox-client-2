// End-to-end verification of the refactored wrapper layer against the mock
// protocol server (test/mock/server.js). No real Firefox needed.
//
//   node test/mock/harness.js
//
// Exercises Console / DOM / Network / StyleSheets through a real FirefoxClient,
// asserting the transforms, object conversions and callbacks behave correctly.
// Prints "ok" per check; exits 0 on success, 1 on the first failure.

var FirefoxClient = require("../../index");
var createMockServer = require("./server").createMockServer;

var checks = 0;

function ok(cond, msg) {
  checks++;
  if (cond) {
    console.log("  ok  - " + msg);
  } else {
    console.error("  FAIL - " + msg);
    shutdown(1);
  }
}

function eq(actual, expected, msg) {
  var same = (actual === expected) ||
             (JSON.stringify(actual) === JSON.stringify(expected));
  ok(same, msg + (same ? "" : "  (got " + JSON.stringify(actual) + ")"));
}

function isFn(x) { return typeof x === "function"; }

function series(tasks, done) {
  var i = 0;
  (function next() {
    var task = tasks[i++];
    if (!task) return done();
    task(next);
  })();
}

var server = createMockServer();
var client;

function shutdown(code) {
  try { if (client) client.disconnect(); } catch (e) {}
  try { server.close(); } catch (e) {}
  process.exit(code);
}

server.listen(0, function() {
  var port = server.address().port;
  client = new FirefoxClient();

  client.connect(port, "localhost", function() {
    client.listTabs(function(err, tabs) {
      ok(!err, "listTabs no error");
      ok(tabs && tabs.length === 1, "listTabs -> 1 tab");
      ok(isFn(tabs[0].navigateTo), "tab has Tab methods");

      var tab = tabs[0];

      series([
        consoleTests(tab),
        domTests(tab),
        networkTests(tab),
        styleTests(tab)
      ], function() {
        console.log("\n" + checks + " checks passed");
        shutdown(0);
      });
    });
  });
});

/* ---- Console ---- */
function consoleTests(tab) {
  return function(next) {
    console.log("\nConsole:");
    var C = tab.Console;

    C.evaluateJS("6 + 7", function(err, resp) {
      ok(!err, "evaluateJS no error");
      eq(resp.result, 13, "evaluateJS '6 + 7' -> 13");

      C.evaluateJS('"hello"', function(err, resp) {
        eq(resp.result, "hello", "evaluateJS string -> 'hello'");

        C.evaluateJS("x = {a: 2}", function(err, resp) {
          ok(resp.result && isFn(resp.result.ownPropertyNames),
             "evaluateJS object -> JSObject (has ownPropertyNames)");

          C.getCachedLogs(function(err, messages) {
            ok(!err, "getCachedLogs no error");
            ok(Array.isArray(messages), "getCachedLogs -> array");

            C.once("console-api-call", function(message) {
              eq(message.level, "log", "'console-api-call' event fires (level=log)");
              next();
            });
            C.startListening(function(err) {
              ok(!err, "startListening no error");
            });
          });
        });
      });
    });
  };
}

/* ---- DOM ---- */
function domTests(tab) {
  return function(next) {
    console.log("\nDOM:");
    var D = tab.DOM;

    D.document(function(err, doc) {
      ok(!err, "document no error");
      eq(doc.nodeName, "#document", "document nodeName");
      eq(doc.nodeType, 9, "document nodeType");
      ok(isFn(doc.querySelector), "document has Node methods");

      D.querySelector(".item", function(err, n) {
        ok(!err, "querySelector no error");
        eq(n.getAttribute("id"), "test1", "querySelector('.item') -> id test1");

        D.querySelectorAll(".item", function(err, list) {
          ok(!err, "querySelectorAll no error");
          eq(list.length, 3, "querySelectorAll list.length 3");

          list.items(function(err, items) {
            ok(!err, "list.items no error");
            eq(items.length, 3, "list.items length 3");
            ok(items.every(function(it) { return isFn(it.querySelector); }),
               "list items are Nodes");
            eq(items.map(function(it) { return it.getAttribute("id"); }),
               ["test1", "test2", "test3"], "item ids");

            items[1].children(function(err, kids) {
              ok(!err, "children no error");
              eq(kids.map(function(k) { return k.getAttribute("id"); }),
                 ["child1", "child2"], "children ids");

              items[1].innerHTML(function(err, html) {
                ok(!err, "innerHTML no error");
                eq(html, "<inner>", "innerHTML value (via pluck)");
                next();
              });
            });
          });
        });
      });
    });
  };
}

/* ---- Network ---- */
function networkTests(tab) {
  return function(next) {
    console.log("\nNetwork:");
    var N = tab.Network;

    N.startLogging(function(err) {
      ok(!err, "startLogging no error");

      N.once("network-event", function(netEvent) {
        ok(isFn(netEvent.getResponseHeaders), "'network-event' -> NetworkEvent");
        eq(netEvent.method, "GET", "network-event method GET");

        N.sendHTTPRequest({ url: "test-network.json", method: "GET" }, function(err, ev) {
          ok(!err, "sendHTTPRequest no error");
          ok(isFn(ev.getResponseHeaders), "sendHTTPRequest -> NetworkEvent (via wrapForm)");

          ev.getRequestHeaders(function(err, resp) {
            ok(!err, "getRequestHeaders no error");
            var found = resp.headers.some(function(h) {
              return h.name === "test-header" && h.value === "test-value";
            });
            ok(found, "getRequestHeaders contains sent header");
            next();
          });
        });
      });

      // triggers the mock to push a networkEvent from the console actor
      tab.Console.evaluateJS("sendRequest()");
    });
  };
}

/* ---- StyleSheets ---- */
function styleTests(tab) {
  return function(next) {
    console.log("\nStyleSheets:");
    var S = tab.StyleSheets;

    S.getStyleSheets(function(err, sheets) {
      ok(!err, "getStyleSheets no error");
      eq(sheets.length, 2, "getStyleSheets length 2 (via mapForms)");
      ok(sheets.every(function(s) { return isFn(s.update); }),
         "sheets are StyleSheets");
      eq(sheets[1].ruleCount, 2, "sheet[1].ruleCount 2");

      var sheet = sheets[1];

      sheet.getText(function(err, text) {
        ok(!err, "getText no error");
        eq(text, "main { color: black; }", "getText (via pluck)");

        sheet.getOriginalSources(function(err, sources) {
          ok(!err, "getOriginalSources no error");
          eq(sources, [], "getOriginalSources null -> [] (mapForms null-safe)");

          sheet.once("disabled-changed", function(disabled) {
            ok(true, "'disabled-changed' event fires");

            S.addStyleSheet("div {}", function(err, ns) {
              ok(!err, "addStyleSheet no error");
              ok(isFn(ns.update), "addStyleSheet -> StyleSheet (via wrapForm)");
              next();
            });
          });

          sheet.toggleDisabled(function(err, disabled) {
            ok(!err, "toggleDisabled no error");
            eq(sheet.disabled, true, "toggleDisabled flips cached disabled");
          });
        });
      });
    });
  };
}
