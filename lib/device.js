var extend = require("./extend"),
    ClientMethods = require("./client-methods");

module.exports = Device;

function Device(client, tab) {
  this.initialize(client, tab.deviceActor);
}

Device.prototype = extend(ClientMethods, {
  getDescription: function(cb) {
    this.request("getDescription", this.pluck('value'), cb);
  },
  getRawPermissionsTable: function(cb) {
    this.request("getRawPermissionsTable", function(resp) {
      return resp.value.rawPermissionsTable;
    }, cb);
  }
})
