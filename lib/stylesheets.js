var extend = require("./extend");
var ClientMethods = require("./client-methods");

module.exports = StyleSheets;

function StyleSheets(client, actor) {
  this.initialize(client, actor);
}

StyleSheets.prototype = extend(ClientMethods, {
  getStyleSheets: function(cb) {
    this.request('getStyleSheets', this.mapForms('styleSheets', StyleSheet), cb);
  },

  addStyleSheet: function(text, cb) {
    this.request('addStyleSheet', { text: text },
                 this.wrapForm('styleSheet', StyleSheet), cb);
  }
})

function StyleSheet(client, sheet) {
  this.initialize(client, sheet.actor);
  this.sheet = sheet;

  this.on("propertyChange", this.onPropertyChange.bind(this));
}

StyleSheet.prototype = extend(ClientMethods, {
  get href() {
    return this.sheet.href;
  },

  get disabled() {
    return this.sheet.disabled;
  },

  get ruleCount() {
    return this.sheet.ruleCount;
  },

  onPropertyChange: function(event) {
    this.sheet[event.property] = event.value;
    this.emit(event.property + "-changed", event.value);
  },

  toggleDisabled: function(cb) {
    this.request('toggleDisabled', function(err, resp) {
      if (err) return cb(err);

      this.sheet.disabled = resp.disabled;
      cb(null, resp.disabled);
    }.bind(this));
  },

  getOriginalSources: function(cb) {
    this.request('getOriginalSources',
                 this.mapForms('originalSources', OriginalSource), cb);
  },

  getMediaRules: function(cb) {
    this.request('getMediaRules', this.mapForms('mediaRules', MediaRule), cb);
  },

  update: function(text, cb) {
    this.request('update', { text: text, transition: true }, cb);
  },

  getText: function(cb) {
    this.request('getText', this.pluck('text'), cb);
  }
});

function MediaRule(client, rule) {
  this.initialize(client, rule.actor);
  this.rule = rule;

  this.on("matchesChange", function(event) {
    this.emit("matches-change", event.matches);
  }.bind(this));
}
MediaRule.prototype = extend(ClientMethods, {
  get mediaText() {
    return this.rule.mediaText;
  },

  get matches() {
    return this.rule.matches;
  }
})

function OriginalSource(client, source) {
  this.initialize(client, source.actor);

  this.source = source;
}

OriginalSource.prototype = extend(ClientMethods, {
  get url()  {
    return this.source.url
  },

  getText: function(cb) {
    this.request('getText', this.pluck('text'), cb);
  }
});
