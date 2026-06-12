/**
 * Minimal end-to-end Debugger example.
 *
 * Run against a Firefox listening for a remote connection (see the README's
 * "Connecting" section), then:
 *
 *   node test/test-debugger.js
 *
 * It attaches to the first tab's thread, sets a breakpoint, and prints the
 * call stack each time execution pauses, single-stepping a few times before
 * detaching.
 */
var FirefoxClient = require("../index");

var MAX_PAUSES = 5;
var pauseCount = 0;

getFirstTab(function(tab, client) {
  var dbg = tab.Debugger;

  // Called every time execution stops on its own: a breakpoint is hit, or a
  // step we requested has completed.
  dbg.on("pause", function(info) {
    var why = info.why ? info.why.type : "?";
    console.log("\npaused (" + why + ")");

    printStack(dbg, function() {
      if (++pauseCount >= MAX_PAUSES) {
        console.log("\ndone stepping, detaching");
        return dbg.detach(function(err) {
          if (err) throw err;
          client.disconnect();
        });
      }
      // step over one line and let it stop again
      dbg.stepOver(function(err) {
        if (err) throw err;
      });
    });
  });

  dbg.on("resume", function() {
    console.log("resumed");
  });

  dbg.on("new-source", function(source) {
    console.log("new source:", source.url);
  });

  // Attaching leaves the thread paused (why: "attached").
  dbg.attach(function(err, paused) {
    if (err) throw err;
    console.log("attached, thread stopped because:", paused.why.type);

    dbg.getSources(function(err, sources) {
      if (err) throw err;
      console.log("known sources:", sources.length);

      // Put a breakpoint on the first line of the first script, then let the
      // page run until it gets there.
      var source = sources[0];
      if (!source) {
        return dbg.resume();
      }

      source.setBreakpoint({ line: 1 }, function(err, bp) {
        if (err) {
          console.log("couldn't set breakpoint:", err.message);
        } else {
          console.log("breakpoint set at", JSON.stringify(bp.actualLocation));
        }
        dbg.resume();
      });
    });
  });
});

/**
 * Print the current call stack: function name and source location per frame.
 */
function printStack(dbg, done) {
  dbg.getFrames(function(err, frames) {
    if (err) throw err;

    frames.forEach(function(frame, i) {
      console.log(
        "  #" + i + " " +
        (frame.functionName || "(anonymous)") + " " +
        frame.url + ":" + frame.line + ":" + frame.column
      );
    });

    done();
  });
}

/**
 * Connect, grab the first tab, and attach to it (so the thread actor and load
 * events are available) before handing it back.
 */
function getFirstTab(callback) {
  var client = new FirefoxClient({ log: false });

  client.connect(function() {
    client.listTabs(function(err, tabs) {
      if (err) throw err;

      var tab = tabs[0];
      tab.attach(function(err) {
        if (err) throw err;
        callback(tab, client);
      });
    });
  });
}
