var events = require("events"),
    extend = require("./extend");

// to be instantiated later - to avoid circular dep resolution
var JSObject;
var Node, NodeList;

var ClientMethods = extend(events.EventEmitter.prototype, {
  /**
   * Intialize this client object.
   *
   * @param  {object} client
   *         Client to send requests on.
   * @param  {string} actor
   *         Actor id to set as 'from' field on requests
   */
  initialize: function(client, actor) {
    this.client = client;
    this.actor = actor;

    this.client.on('message', function(message) {
      if (message.from == this.actor) {
        this.emit(message.type, message);
      }
    }.bind(this));
  },

  /**
   * Make request to our actor on the server.
   *
   * @param  {string}   type
   *         Method name of the request
   * @param  {object}   message
   *         Optional extra properties (arguments to method)
   * @param  {Function}   transform
   *         Optional tranform for response object. Takes response object
   *         and returns object to send on.
   * @param  {Function} callback
   *         Callback to call with (maybe transformed) response
   */
  request: function(type, message, transform, callback) {
    if (typeof message == "function") {
      if (typeof transform == "function") {
        // (type, trans, cb)
        callback = transform;
        transform = message;
      }
      else {
        // (type, cb)
        callback = message;
      }
      message = {};
    }
    else if (!callback) {
      if (!message) {
        // (type)
        message = {};
      }
      // (type, message, cb)
      callback = transform;
      transform = null;
    }

    message.to = this.actor;
    message.type = type;

    this.client.makeRequest(message, function(resp) {
      delete resp.from;

      if (resp.error) {
        var err = new Error(resp.message);
        err.name = resp.error;

        callback(err);
        return;
      }

      if (transform) {
        resp = transform(resp);
      }

      if (callback) {
        callback(null, resp);
      }
    });
  },

  /*
   * Transform obj response into a JSObject
   */
  createJSObject: function(obj) {
    if (obj == null) {
      return;
    }
    if (!JSObject) {
      // circular dependencies
      JSObject = require("./jsobject");
    }
    if (obj.type == "object") {
      return new JSObject(this.client, obj);
    }
    return obj;
  },

  /**
   * Create function that plucks out only one value from an object.
   * Used as the transform function for some responses.
   */
  pluck: function(prop) {
    return function(obj) {
      return obj[prop];
    }
  },

  /**
   * Create a transform that maps a list of actor forms at resp[prop] into
   * wrapper instances. The returned transform is already bound, so it can be
   * passed straight to request(). Missing/null lists become an empty array.
   *
   * @param  {string}   prop
   *         Property on the response holding the array of forms.
   * @param  {Function} Ctor
   *         Wrapper constructor taking (client, form).
   */
  mapForms: function(prop, Ctor) {
    var self = this;
    return function(resp) {
      return (resp[prop] || []).map(function(form) {
        return new Ctor(self.client, form);
      });
    };
  },

  /**
   * Create a transform that wraps a single actor form at resp[prop] into a
   * wrapper instance, or null if it's absent. The returned transform is
   * already bound, so it can be passed straight to request().
   *
   * @param  {string}   prop
   *         Property on the response holding the form.
   * @param  {Function} Ctor
   *         Wrapper constructor taking (client, form).
   */
  wrapForm: function(prop, Ctor) {
    var self = this;
    return function(resp) {
      return resp[prop] ? new Ctor(self.client, resp[prop]) : null;
    };
  },

  /*
   * Transform a response into a single Node (or null). Shared by Node and
   * NodeList; relies on `this.client` and `this.walker`, so callers bind it.
   */
  getNode: function(resp) {
    requireNode();
    if (resp.node) {
      return new Node(this.client, this.walker, resp.node);
    }
    return null;
  },

  /*
   * Transform a response's `nodes` array into Node instances. Shared by Node
   * and NodeList; relies on `this.client`/`this.walker`, so callers bind it.
   */
  getNodeArray: function(resp) {
    requireNode();
    return resp.nodes.map(function(form) {
      return new Node(this.client, this.walker, form);
    }.bind(this));
  },

  /*
   * Transform a response's `list` into a NodeList. Shared by Node and
   * NodeList; relies on `this.client`/`this.walker`, so callers bind it.
   */
  getNodeList: function(resp) {
    requireNode();
    return new NodeList(this.client, this.walker, resp.list);
  }
})

// lazily resolve domnode to avoid circular dependencies (domnode requires
// this module). NodeList is exposed as Node.NodeList.
function requireNode() {
  if (!Node) {
    Node = require("./domnode");
    NodeList = Node.NodeList;
  }
}

module.exports = ClientMethods;