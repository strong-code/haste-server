var winston = require('winston');
var Busboy = require('busboy');
var path = require('path');

// For handling serving stored documents

var DocumentHandler = function(options) {
  if (!options) {
    options = {};
  }
  this.keyLength = options.keyLength || DocumentHandler.defaultKeyLength;
  this.maxLength = options.maxLength; // none by default
  this.store = options.store;
  this.keyGenerator = options.keyGenerator;
};

DocumentHandler.defaultKeyLength = 10;

// Handle retrieving a document
DocumentHandler.prototype.handleGet = function(key, response, skipExpire) {
  this.store.get(key, function(ret) {
    if (ret) {
      winston.verbose('retrieved document', { key: key });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: ret, key: key }));
    }
    else {
      winston.warn('document not found', { key: key });
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Document not found.' }));
    }
  }, skipExpire);
};

// Handle retrieving the raw version of a document
DocumentHandler.prototype.handleRawGet = function(key, response, skipExpire) {
  this.store.get(key, function(ret) {
    if (ret) {
      winston.verbose('retrieved raw document', { key: key });
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(ret);
    }
    else {
      winston.warn('raw document not found', { key: key });
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Document not found.' }));
    }
  }, skipExpire);
};

DocumentHandler.prototype.handleDelete = function (key, response) {
  this.store.delete(key, function (success) {
    if (success) {
      winston.verbose('Deleted document under key ' + key);
      response.writeHead(200);
      response.end(JSON.stringify({ message: 'Deleted document under key ' + key }));
    } else {
      winston.warn('No file found for key ' + key);
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'No file found for key ' + key }));
    }
  });
}

// Handle adding a new Document
DocumentHandler.prototype.handlePost = function (request, response) {
  var _this = this;
  var buffer = '';
  var cancelled = false;
  var mime = '';

  // What to do when done
  var onSuccess = function () {
    // And then save if we should
    _this.chooseKey(function (key) {
      _this.store.set(key, buffer, mime, function (res) {
        if (res) {
          var filename = key + mime;
          winston.verbose('added document', { key: key });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(filename);
        }
        else {
          winston.verbose('error adding document');
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ message: 'Error adding document.' }));
        }
      });
    });
  };

  // If we should, parse a form to grab the data
  var ct = request.headers['content-type'];
  if (ct && ct.split(';')[0] === 'multipart/form-data') {
    var busboy = new Busboy({ headers: request.headers });
    var authed = true;
    var _mime;

    busboy.on('file', function (fieldname, file, filename, encoding, mime) {
      _mime = path.extname(filename);
      buffers = [];
      file.on('data', function (data) {
        buffers.push(new Buffer(data))
      });
      file.on('end', function () {
        buffer = Buffer.concat(buffers);
      });
    });
    busboy.on('field', function (name, val) {
      var authTokens = require('../tokens.json');
      if (name === 'uuid') {
        val = val.split(':');
        if (authTokens[val[0]] === val[1]) {
          authed = true;
        }
      }
    });
    busboy.on('finish', function () {
      if (!authed) {
        winston.verbose('User not authed!');
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Could not authenticate with UUID' }));
        cancelled = true;
      } else {
        mime = _mime;
        onSuccess();
      }
    });
    request.pipe(busboy);
  // Otherwise, use our own and just grab flat data from POST body
  } else {
    request.on('data', function (data) {
      buffer += data.toString();
    });
    request.on('end', function () {
      if (cancelled) { return; }
      onSuccess();
    });
    request.on('error', function (error) {
      winston.error('connection error: ' + error.message);
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Connection error.' }));
      cancelled = true;
    });
  }
};

// Keep choosing keys until one isn't taken
DocumentHandler.prototype.chooseKey = function(callback) {
  var key = this.acceptableKey();
  var _this = this;
  this.store.get(key, function(ret) {
    if (ret) {
      _this.chooseKey(callback);
    } else {
      callback(key);
    }
  });
};

DocumentHandler.prototype.acceptableKey = function() {
  return this.keyGenerator.createKey(this.keyLength);
};

module.exports = DocumentHandler;
