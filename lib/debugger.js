var extend = require("./extend"),
    ClientMethods = require("./client-methods");

module.exports = Debugger;

/**
 * The Debugger wraps a tab's thread actor, exposing the basic debugging
 * lifecycle: attach/detach, pause/resume, single stepping, plus access to
 * the running scripts (Sources) and the current call stack (Frames).
 *
 * It follows the same shape as the other tab modules (Console, Network):
 * make requests with a node-style (err, result) callback, and listen for
 * events with `on`/`once`.
 *
 * Events:
 *   "pause"      - execution stopped (breakpoint, step, or interrupt).
 *                  Handler gets { why, frame } where `frame` is a Frame.
 *   "resume"     - execution resumed.
 *   "new-source" - a new Source became available. Handler gets a Source.
 *   "new-global" - a new global/document was created.
 */
function Debugger(client, actor) {
  this.initialize(client, actor);

  // Whether the thread is currently paused. Kept in sync from both the
  // request replies (attach/pause/resume) and the unsolicited events below.
  this.paused = false;

  // The raw protocol types "paused"/"resumed" are re-emitted under the
  // distinct public names "pause"/"resume" so we never re-enter our own
  // handler (which would happen if we re-emitted under the same name).
  this.on("paused", this.onPaused.bind(this));
  this.on("resumed", this.onResumed.bind(this));
  this.on("newSource", this.onNewSource.bind(this));
  this.on("newGlobal", this.onNewGlobal.bind(this));
}

Debugger.prototype = extend(ClientMethods, {
  /**
   * Attach to the thread so we can pause it and receive debugger events.
   * Attaching leaves the thread paused, so you'll usually call resume()
   * afterwards to let the page run until a breakpoint is hit.
   *
   * @param {object}   [options] - e.g. { useSourceMaps, autoBlackBox }
   * @param {Function} cb        - (err, { why, frame })
   */
  attach: function(options, cb) {
    if (typeof options == "function") {
      cb = options;
      options = {};
    }
    // The reply to "attach" is itself a paused packet (why: "attached").
    this.request("attach", options || {}, function(resp) {
      this.paused = true;
      return this.createPaused(resp);
    }.bind(this), cb);
  },

  /**
   * Detach from the thread, letting it run freely again.
   *
   * @param {Function} cb - (err)
   */
  detach: function(cb) {
    this.request("detach", function(resp) {
      this.paused = false;
      return resp;
    }.bind(this), cb);
  },

  /**
   * Interrupt the running thread, pausing it as soon as possible. The reply
   * carries the location we stopped at.
   *
   * @param {Function} cb - (err, { why, frame })
   */
  pause: function(cb) {
    this.request("interrupt", { when: "auto" }, function(resp) {
      this.paused = true;
      return this.createPaused(resp);
    }.bind(this), cb);
  },

  /**
   * Resume a paused thread and let it run until the next breakpoint.
   *
   * @param {Function} cb - (err)
   */
  resume: function(cb) {
    this.resumeWith(null, cb);
  },

  /**
   * Step to the next line in the current frame (don't descend into calls).
   *
   * The reply only acknowledges that the thread resumed; the location it
   * stops at next arrives via the "pause" event.
   *
   * @param {Function} cb - (err)
   */
  stepOver: function(cb) {
    this.resumeWith({ type: "next" }, cb);
  },

  /**
   * Step into the next function call (or to the next line if there is none).
   *
   * @param {Function} cb - (err)
   */
  stepIn: function(cb) {
    this.resumeWith({ type: "step" }, cb);
  },

  /**
   * Step out of the current frame, pausing once it returns to the caller.
   *
   * @param {Function} cb - (err)
   */
  stepOut: function(cb) {
    this.resumeWith({ type: "finish" }, cb);
  },

  /**
   * Resume with an optional resume limit (used by the stepping helpers).
   *
   * @param {object|null} resumeLimit - null, or { type: "next"|"step"|"finish" }
   * @param {Function}    cb          - (err)
   */
  resumeWith: function(resumeLimit, cb) {
    this.request("resume", { resumeLimit: resumeLimit }, function(resp) {
      this.paused = false;
      return resp;
    }.bind(this), cb);
  },

  /**
   * List the scripts currently known to the thread.
   *
   * @param {Function} cb - (err, [Source])
   */
  getSources: function(cb) {
    this.request("sources", function(resp) {
      return (resp.sources || []).map(function(form) {
        return new Source(this.client, form);
      }.bind(this));
    }.bind(this), cb);
  },

  /**
   * Get the current call stack as an array of Frames (innermost first).
   * Only meaningful while the thread is paused.
   *
   * @param {number}   [start] - index of the first frame to return
   * @param {number}   [count] - max number of frames (0/omitted = all)
   * @param {Function} cb      - (err, [Frame])
   */
  getFrames: function(start, count, cb) {
    if (typeof start == "function") {
      cb = start;
      start = 0;
      count = 0;
    }
    else if (typeof count == "function") {
      cb = count;
      count = 0;
    }
    this.request("frames", { start: start, count: count }, function(resp) {
      return (resp.frames || []).map(function(form) {
        return new Frame(this.client, form);
      }.bind(this));
    }.bind(this), cb);
  },

  /**
   * Set a breakpoint at a source location.
   *
   * @param {object}   location - { url, line, column? }
   * @param {Function} cb       - (err, { actor, actualLocation })
   */
  setBreakpoint: function(location, cb) {
    this.request("setBreakpoint", { location: location }, function(resp) {
      return {
        actor: resp.actor,
        actualLocation: resp.actualLocation || location
      };
    }, cb);
  },

  /* event handlers - re-emit unsolicited protocol events in module style */

  onPaused: function(packet) {
    this.paused = true;
    this.emit("pause", this.createPaused(packet));
  },

  onResumed: function() {
    this.paused = false;
    this.emit("resume");
  },

  onNewSource: function(packet) {
    this.emit("new-source", new Source(this.client, packet.source));
  },

  onNewGlobal: function(packet) {
    this.emit("new-global", packet);
  },

  /**
   * Normalize a paused packet into { why, frame } with `frame` wrapped as a
   * Frame so callers can read script/function/line/column directly.
   */
  createPaused: function(packet) {
    return {
      why: packet.why,
      frame: packet.frame ? new Frame(this.client, packet.frame) : null
    };
  }
})

/**
 * A Source is one script known to the debugger. It's a thin wrapper: it only
 * makes request/response calls, so (like NodeList) it does not register a
 * 'message' listener on the client.
 */
function Source(client, form) {
  this.client = client;
  this.actor = form.actor;
  this.form = form;
}

Source.prototype = extend(ClientMethods, {
  get url() {
    return this.form.url;
  },

  get introductionType() {
    return this.form.introductionType;
  },

  get sourceMapURL() {
    return this.form.sourceMapURL;
  },

  /**
   * Get the full text of this script.
   *
   * @param {Function} cb - (err, source)
   */
  getText: function(cb) {
    this.request("source", function(resp) {
      return resp.source;
    }, cb);
  },

  /**
   * Set a breakpoint within this script.
   *
   * @param {object}   location - { line, column? }
   * @param {Function} cb       - (err, { actor, actualLocation })
   */
  setBreakpoint: function(location, cb) {
    this.request("setBreakpoint", { location: location }, function(resp) {
      return {
        actor: resp.actor,
        actualLocation: resp.actualLocation || location
      };
    }, cb);
  }
})

/**
 * A Frame is one entry in the call stack at a pause. It exposes where we are
 * (script url, line, column), which function we're in, the arguments, and the
 * frame's `this` value. Like Source, it's request/response only and does not
 * register a 'message' listener.
 */
function Frame(client, form) {
  this.client = client;
  this.actor = form.actor;
  this.form = form;
}

Frame.prototype = extend(ClientMethods, {
  // "call", "global", "eval", etc.
  get type() {
    return this.form.type;
  },

  // raw location object: { source/url, line, column }
  get where() {
    return this.form.where || {};
  },

  get url() {
    var where = this.where;
    return where.url || (where.source && where.source.url);
  },

  get line() {
    return this.where.line;
  },

  get column() {
    return this.where.column;
  },

  // depth in the stack (0 = innermost)
  get depth() {
    return this.form.depth;
  },

  // name of the function this frame is executing, "" for anonymous/top-level
  get functionName() {
    if (this.form.callee) {
      return this.form.callee.name || this.form.callee.displayName || "";
    }
    return this.form.calleeName || "";
  },

  // the arguments passed to this frame, as JSObjects/primitives
  get args() {
    return (this.form.arguments || []).map(this.createJSObject.bind(this));
  },

  // the `this` binding of the frame, as a JSObject/primitive
  get receiver() {
    return this.createJSObject(this.form.this);
  }
})
