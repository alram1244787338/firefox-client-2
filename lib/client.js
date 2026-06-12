var net = require("net"),
    events = require("events"),
    extend = require("./extend");

var colors = require("colors");

module.exports = Client;

/**
 * Build an Error tagged with a `category` so callers can distinguish
 * connection failures, bad protocol data, and local processing errors.
 * category is one of "connection", "protocol", "local".
 */
function taggedError(category, message) {
  var err = new Error(message);
  err.category = category;
  return err;
}

// this is very unfortunate! and temporary. we can't
// rely on 'type' property to signify an event, and we
// need to write clients for each actor to handle differences
// in actor protocols
var unsolicitedEvents = {
  "tabNavigated": "tabNavigated",
  "styleApplied": "styleApplied",
  "propertyChange": "propertyChange",
  "networkEventUpdate": "networkEventUpdate",
  "networkEvent": "networkEvent",
  "propertyChange": "propertyChange",
  "newMutations": "newMutations",
  "appOpen": "appOpen",
  "appClose": "appClose",
  "appInstall": "appInstall",
  "appUninstall": "appUninstall",
  "frameUpdate": "frameUpdate"
};

/**
 * a Client object handles connecting with a Firefox remote debugging
 * server instance (e.g. a Firefox instance), plus sending and receiving
 * packets on that conection using the Firefox remote debugging protocol.
 *
 * Important methods:
 * connect - Create the connection to the server.
 * makeRequest - Make a request to the server with a JSON message,
 *   and a callback to call with the response.
 *
 * Important events:
 * 'message' - An unsolicited (e.g. not a response to a prior request)
 *    packet has been received. These packets usually describe events.
 */
function Client(options) {
  this.options = options || {};

  this.incoming = Buffer.alloc(0);

  this._pendingRequests = [];
  this._activeRequests = {};
}

Client.prototype = extend(events.EventEmitter.prototype, {
  connect: function(port, host, cb) {
    this.client = net.createConnection({
      port: port,
      host: host
    });

    this.client.on("connect", cb);
    this.client.on("data", this.onData.bind(this));
    this.client.on("error", this.onError.bind(this));
    this.client.on("end", this.onEnd.bind(this));
    this.client.on("timeout", this.onTimeout.bind(this));
  },

  disconnect: function() {
    if (this.client) {
      this.client.end();
    }
  },

  /**
   * Set a request to be sent to an actor on the server. If the actor
   * is already handling a request, queue this request until the actor
   * has responded to the previous request.
   *
   * @param {object} request
   *        Message to be JSON-ified and sent to server.
   * @param {function} callback
   *        Function that's called with the response from the server.
   */
  makeRequest: function(request, callback) {
    this.log("request: " + JSON.stringify(request).green);

    if (!request.to) {
      var type = request.type || "";
      throw taggedError("local", type + " request packet has no destination.");
    }
    this._pendingRequests.push({ to: request.to,
                                 message: request,
                                 callback: callback });
    this._flushRequests();
  },

  /**
   * Activate (send) any pending requests to actors that don't have an
   * active request.
   */
  _flushRequests: function() {
    this._pendingRequests = this._pendingRequests.filter(function(request) {
      // only one active request per actor at a time
      if (this._activeRequests[request.to]) {
        return true;
      }

      // no active requests for this actor, so activate this one
      this.sendMessage(request.message);
      this.expectReply(request.to, request.callback);

      // remove from pending requests
      return false;
    }.bind(this));
  },

  /**
   * Send a JSON message over the connection to the server.
   */
  sendMessage: function(message) {
    if (!message.to) {
      throw taggedError("local", "No actor specified in request");
    }
    if (!this.client) {
      throw taggedError("local", "Not connected, connect() before sending requests");
    }
    var str = JSON.stringify(message);

    // message is preceded by byteLength(message):
    str = Buffer.byteLength(str) + ":" + str;

    this.client.write(str);
  },

  /**
   * Arrange to hand the next reply from |actor| to |handler|.
   */
  expectReply: function(actor, handler) {
    if (this._activeRequests[actor]) {
      throw taggedError("local",
        "clashing handlers for next reply from " + JSON.stringify(actor));
    }
    this._activeRequests[actor] = handler;
  },

  /**
   * Handler for a new message coming in. It's either an unsolicited event
   * from the server, or a response to a previous request from the client.
   */
  handleMessage: function(message) {
    if (!message.from) {
      if (message.error) {
        // the server returned an error packet without naming an actor
        this.emitError("protocol", message.message || message.error);
        return;
      }
      this.emitError("protocol",
        "Server didn't specify an actor: " + JSON.stringify(message));
      return;
    }

    if (!(message.type in unsolicitedEvents)
        && this._activeRequests[message.from]) {
      this.log("response: " + JSON.stringify(message).yellow);

      var callback = this._activeRequests[message.from];
      delete this._activeRequests[message.from];

      callback(message);

      this._flushRequests();
    }
    else if (message.type) {
      // this is an unsolicited event from the server
      this.log("unsolicited event: ".grey + JSON.stringify(message).grey);

      this.emit('message', message);
      return;
    }
    else {
      this.emitError("protocol", "Unexpected packet from actor "
        + message.from + ": " + JSON.stringify(message));
      return;
    }
  },

  /**
   * Called when a new data chunk is received on the connection.
   * Parse data into message(s) and call message handler for any full
   * messages that are read in.
   */
  onData: function(data) {
    this.incoming = Buffer.concat([this.incoming, data]);

    while(this.readMessage()) {};
  },

  /**
   * Parse out and process the next message from the data read from
   * the connection. Returns true if a full meassage was parsed, false
   * otherwise.
   */
  readMessage: function() {
    // The header is "<byteLengthOfBody>:" at the start of the buffer.
    // Search for the ':' byte (0x3A) directly so we never decode a
    // partial multi-byte UTF-8 sequence and the index stays byte-accurate.
    var sep = this.incoming.indexOf(0x3A);
    if (sep < 0) {
      // no separator yet, wait for more data
      return false;
    }

    var header = this.incoming.slice(0, sep).toString("ascii");
    if (!/^\d+$/.test(header)) {
      // length prefix is not a non-negative integer: the stream is
      // corrupt and message boundaries can no longer be trusted. Surface
      // a protocol error and drop the buffer instead of crashing.
      this.emitError("protocol",
        "Invalid length prefix from server: " + JSON.stringify(header));
      this.incoming = Buffer.alloc(0);
      return false;
    }
    var count = parseInt(header, 10);

    if (this.incoming.length - (sep + 1) < count) {
      this.log("no complete response yet".grey);
      return false;
    }

    // slice the body out by bytes (count is a byte length)
    var packet = this.incoming.slice(sep + 1, sep + 1 + count);
    this.incoming = this.incoming.slice(sep + 1 + count);

    var message;
    try {
      message = JSON.parse(packet.toString());
    } catch(e) {
      // framing was valid (we consumed exactly `count` bytes), so we can
      // keep parsing later messages; just report this bad packet.
      this.emitError("protocol",
        "Couldn't parse packet from server as JSON: " + e.message);
      return true;
    }
    this.handleMessage(message);

    return true;
  },

  onError: function(error) {
    var code = error.code ? error.code : error;
    this.log("connection error: ".red + code.red);
    if (error && typeof error === "object") {
      error.category = "connection";
    }
    this.emit("error", error);
  },

  onEnd: function() {
    this.log("connection closed by server".red);
    this.emit("end");
  },

  onTimeout: function() {
    this.log("connection timeout".red);
    this.emit("timeout");
  },

  /**
   * Emit an Error tagged with a `category` ("connection" | "protocol" |
   * "local") so listeners can tell connection failures, bad protocol data,
   * and local processing errors apart.
   */
  emitError: function(category, message) {
    this.emit("error", taggedError(category, message));
  },

  log: function(str) {
    if (this.options.log) {
      console.log(str);
    }
  }
})
