/* mysql-live-select, MIT License ben@latenightsketches.com
   lib/LiveMysql.js - Main Class */
var ZongJi = require('zongji');
var mysql = require('mysql');

// Maximum duration to wait for Zongji to initialize before timeout error (ms)
var ZONGJI_INIT_TIMEOUT = 1500;

var LiveMysqlSelect = require('./LiveMysqlSelect');

function LiveMysql(settings, callback){
  var self = this;
  var db = mysql.createConnection(settings);

  self.settings = settings;
  self.zongji = null;
  self.db = db;
  self._select = [];
  // Cache query results for any new, duplicate SELECT statements
  self._resultsBuffer = {};
  self._schemaCache = {};

  self.zongjiSettings = {
    serverId: settings.serverId,
    startAtEnd: true,
    includeEvents: [ 'tablemap', 'writerows', 'updaterows', 'deleterows' ],
    includeSchema: self._schemaCache
  };

  self.db.connect(function(error){
    if(error) return callback && callback(error);

    var zongji = self.zongji = new ZongJi(self.settings);

    zongji.on('binlog', function(event) {
      if(event.getEventName() === 'tablemap') return;
      if(self._select.length === 0) return;

      // Cache query results within this update event
      var eventResults = {};

      // Update each select statement if matches event
      function _nextSelect(index){
        var select;
        if(index < self._select.length){
          select = self._select[index];
          if(select.matchRowEvent(event)){
            if(select.query in eventResults){
              select._setRows(eventResults[select.query]);
              _nextSelect(index + 1);
            }else{
              select.update(function(error, rows){
                if(error === undefined){
                  eventResults[select.query] = rows;
                }
                _nextSelect(index + 1);
              });
            }
          }else{
            _nextSelect(index + 1);
          }
        }
      }

      _nextSelect(0);

    });

    // Wait for Zongji to be ready before executing callback
    var zongjiInitTime = Date.now();
    var zongjiReady = function() {
      if(zongji.ready === true) {
        // Call the callback if it exists and do not keep waiting
        callback && callback();
      } else {
        // Wait for Zongji to be ready
        if(Date.now() - zongjiInitTime > ZONGJI_INIT_TIMEOUT) {
          // Zongji initialization has exceeded timeout, callback error
          callback && callback(new Error('ZONGJI_INIT_TIMEOUT_OCCURED'));
        } else {
          setTimeout(zongjiReady, 40);
        }
      }
    };
    zongji.start(self.zongjiSettings);
    zongjiReady();
  });
}

LiveMysql.prototype.select = function(query, triggers){
  var self = this;

  if(!(triggers instanceof Array) ||
     triggers.length === 0)
    throw new Error('triggers array required');

  // Update schema included in ZongJi events
  var includeSchema = self._schemaCache;
  for(var i = 0; i < triggers.length; i++){
    var triggerDatabase = triggers[i].database || self.settings.database;
    if(triggerDatabase === undefined){
      throw new Error('no database selected on trigger');
    }
    if(!(triggerDatabase in includeSchema)){
      includeSchema[triggerDatabase] = [ triggers[i].table ];
    }else if(includeSchema[triggerDatabase].indexOf(triggers[i].table) === -1){
      includeSchema[triggerDatabase].push(triggers[i].table);
    }
  }

  var newSelect = new LiveMysqlSelect(query, triggers, this);
  self._select.push(newSelect);
  return newSelect;
};

LiveMysql.prototype.pause = function(){
  var self = this;
  self.zongjiSettings.includeSchema = {};
  self.zongji.set(self.zongjiSettings);
};

LiveMysql.prototype.resume = function(){
  var self = this;
  self.zongjiSettings.includeSchema = self._schemaCache;
  self.zongji.set(self.zongjiSettings);

  // Update all select statements
  self._select.forEach(function(select) {
    select.update();
  });
};

LiveMysql.prototype.end = function(){
  var self = this;
  self.zongji.stop();
  self.db.destroy();
};

// Expose child constructor for prototype enhancements
LiveMysql.LiveMysqlSelect = LiveMysqlSelect;

module.exports = LiveMysql;
