var http = require('http');
var url = require('url');
var fs = require('fs');
var authTokens = require('./tokens.json');
var winston = require('winston');
var connect = require('connect');
var route = require('connect-route');
var connect_st = require('st');
var connect_rate_limit = require('connect-ratelimit');
var Busboy = require('busboy');
var DocumentHandler = require('./lib/document_handler');

// Load the configuration and set some defaults
var config = JSON.parse(fs.readFileSync('./config.js', 'utf8'));
config.port = process.env.PORT || config.port || 7777;
config.host = process.env.HOST || config.host || 'localhost';

// Set up the logger
if (config.logging) {
  try {
    winston.remove(winston.transports.Console);
  } catch(er) { }
  var detail, type;
  for (var i = 0; i < config.logging.length; i++) {
    detail = config.logging[i];
    type = detail.type;
    delete detail.type;
    winston.add(winston.transports[type], detail);
  }
}

// build the store from the config on-demand - so that we don't load it
// for statics
if (!config.storage) {
  config.storage = { type: 'file' };
}
if (!config.storage.type) {
  config.storage.type = 'file';
}

var Store, preferredStore;

if (process.env.REDISTOGO_URL && config.storage.type === 'redis') {
  var redisClient = require('redis-url').connect(process.env.REDISTOGO_URL);
  Store = require('./lib/document_stores/redis');
  preferredStore = new Store(config.storage, redisClient);
}
else {
  Store = require('./lib/document_stores/' + config.storage.type);
  preferredStore = new Store(config.storage);
}

// Compress the static javascript assets
if (config.recompressStaticAssets) {
  var jsp = require("uglify-js").parser;
  var pro = require("uglify-js").uglify;
  var list = fs.readdirSync('./static');
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    var orig_code, ast;
    if ((item.indexOf('.js') === item.length - 3) &&
        (item.indexOf('.min.js') === -1)) {
      dest = item.substring(0, item.length - 3) + '.min' +
        item.substring(item.length - 3);
      orig_code = fs.readFileSync('./static/' + item, 'utf8');
      ast = jsp.parse(orig_code);
      ast = pro.ast_mangle(ast);
      ast = pro.ast_squeeze(ast);
      fs.writeFileSync('./static/' + dest, pro.gen_code(ast), 'utf8');
      winston.info('compressed ' + item + ' into ' + dest);
    }
  }
}

// Pick up a key generator
var pwOptions = config.keyGenerator || {};
pwOptions.type = pwOptions.type || 'random';
var gen = require('./lib/key_generators/' + pwOptions.type);
var keyGenerator = new gen(pwOptions);

// Configure the document handler
var documentHandler = new DocumentHandler({
  store: preferredStore,
  maxLength: config.maxLength,
  keyLength: config.keyLength,
  keyGenerator: keyGenerator
});

var app = connect();

// Simple token-based auth middleware
function tokenAuth(req, res, next) {
  var busboy = new Busboy({ headers: req.headers });
  var authed = false;

  busboy.on('field', function (name, val) {
    if (name === 'uuid') {
      for (var user in authTokens) {
        if (authTokens[user] === val) {
          authed = true;
        }
      }
    }
  });
  busboy.on('finish', function () {
    console.log('finished parsing');
    if (!authed) {
      winston.warn('User not authed!');
      res.writeHead(403);
      return res.end(JSON.stringify({ error: 'Could not authenticate with UUID' }));
    } else {
      console.log('authed!')
      next();
    }
  });
  req.pipe(busboy);
}

app.use('/documents', tokenAuth);

// Rate limit all requests
if (config.rateLimits) {
  config.rateLimits.end = true;
  app.use(connect_rate_limit(config.rateLimits));
}

// first look at API calls
app.use(route(function(router) {
  // get raw documents - support getting with extension
  router.get('/raw/:id', function(request, response, next) {
    var skipExpire = !!config.documents[request.params.id];
    var key = request.params.id.split('.')[0];
    return documentHandler.handleRawGet(key, response, skipExpire);
  });
  // add documents
  router.post('/documents', function(request, response, next) {
    return documentHandler.handlePost(request, response);
  });
  // get documents
  router.get('/documents/:id', function(request, response, next) {
    var skipExpire = !!config.documents[request.params.id];
    return documentHandler.handleGet(
      request.params.id,
      response,
      skipExpire
    );
  });
  // delete documents
  router.delete('/delete/:id', function(request, response, next) {
    console.log(request.params.id)
    return documentHandler.handleDelete(request.params.id, response);
  })
}));

// Host all /data as a static dir
app.use(connect_st({
  path: __dirname + '/data',
  content: { maxAge: config.staticMaxAge },
  url: '/data',
  index: false
}));

// Then we can loop back - and everything else should be a token,
// so route it back to /
app.use(route(function(router) {
  router.get('/:id', function(request, response, next) {
    request.sturl = '/';
    next();
  });
}));

// And match index
app.use(connect_st({
  path: __dirname + '/static',
  content: { maxAge: config.staticMaxAge },
  index: 'index.html'
}));

http.createServer(app).listen(config.port, config.host);

winston.info('listening on ' + config.host + ':' + config.port);
