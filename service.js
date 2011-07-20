var https = require('https');
var querystring = require('querystring');
var util = require('util');
var logging = require('./log');
var fs = require('fs');
var redis = require("redis"),
    client = redis.createClient();

logging.rootLogger.level = logging.INFO;

var logger = logging.log('service');
 
var mapping = {};
var tokens = {};
var options = {
	key: fs.readFileSync('server.key'),
	cert: fs.readFileSync('server.crt')
};

https.createServer(options, function (req, res) {
	switch(req.url) {
		case '/login':
			handlePOST(res, req, ['username', 'auth'], function(post) {
					if(tokens[post.username + ":" + post.auth]) {
						logger.notice("[200] " + req.method + " to " + req.url);
						res.writeHead(200, "OK", {'Content-Type': 'text/plain'});

						var token = tokens[post.username + ":" + post.auth];
						res.end(token);
						logger.debug('recycled the token %s', token);
						return;
					}

					var gtalk = require('./gtalk')(randomString(96), post.username, post.auth);

					gtalk.on('auth_failure', function(details) {
						logger.notice("[401] " + req.method + " to " + req.url);
						res.writeHead(401, "Authentication Required", {'Content-Type': 'text/plain'});
						res.end('401 - Authentication Required');
					}).on('message', function(data) { logger.debug(JSON.stringify(data)); });
					//.on('presence', function(data) { logger.debug(JSON.stringify(data)); });

					gtalk.login(function() {
						logger.notice("[200] " + req.method + " to " + req.url);
						res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
						
						logger.notice('session started ' + gtalk.username);

						mapping[gtalk.token] = gtalk;
						tokens[post.username + ":" + post.auth] = gtalk.token;
						
						res.end(gtalk.token);
					});
			});
			
			break;
		case '/message':
			handlePOST(res, req, ['token', 'to', 'body'], function(post) {
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
				res.end();
				mapping[post.token].message(post.to, post.body);
			});
			
			break;
		case '/roster':
			handlePOST(res, req, ['token'], function(post) {
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/json'});
				mapping[post.token].roster(function(ros) {
					if(ros == null) {
						res.end();
					} else {
						res.write(JSON.stringify(ros) + "\n");
					}
				});
			});
			
			break;
		case '/messagequeue':
			handlePOST(res, req, ['token'], function(post) {
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/json'});
				mapping[post.token].messageQueue(function(msg) {
					if(ros == null) {
						res.end();
					} else {
						res.write(JSON.stringify(msg) + "\n");
					}
				});
			});
			
			break;
		case '/logout':
			handlePOST(res, req, ['token'], function(post) {
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
				res.end();
				
				logger.notice('session ended ' + mapping[post.token].username);
				mapping[post.token].logout();
				mapping[post.token] = undefined;
			});
			
			break;
		case '/register':
			handlePOST(res, req, ['token', 'url'], function(post) {
				if(!post.url.match(/(https?):\/\/([a-z0-9.-]+)(?::([0-9]+))?(\/.*)?$/)) {
					logger.notice("[400] " + req.method + " to " + req.url);
					logger.debug('what the url? %s', post.url);
					res.writeHead(400, "Bad Request", {'Content-Type': 'text/plain'});
					res.end('400 - Bad Request');
				} else {
					logger.notice("[200] " + req.method + " to " + req.url);
					res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
					res.end();
					mapping[post.token].register(post.url);
				}
			});

			break;
		default:
			logger.notice("[404] " + req.method + " to " + req.url);
			res.writeHead(404, "Not found", {'Content-Type': 'text/plain'});
			res.end('404 - Not found');
			break;
	}
}).listen(443);

function randomString(bits) {
	var rand, i;
	var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/';
	var ret = '';
	
	// in v8, Math.random() yields 32 pseudo-random bits (in spidermonkey it gives 53)
	while(bits > 0) {
		rand = Math.floor(Math.random()*0x100000000); // 32-bit integer
		 
		// base 64 means 6 bits per character, so we use the top 30 bits from rand to give 30/6=5 characters.
		for(i = 26; i > 0 && bits > 0; i -= 6, bits -= 6) {
			ret += chars[0x3F & rand >>> i];
		}
	}
	
	return ret;
}

function handlePOST(res, req, params, cb) {
	if(req.method == 'POST') {
		var fullBody = '';

		req.on('data', function(chunk) {
			// append the current chunk of data to the fullBody variable
			fullBody += chunk.toString();
		}).on('end', function() {
			// parse the received body data
			var post = querystring.parse(fullBody);

			logger.debug('\tRequest %s ', JSON.stringify(post));

			var tokens = [];
			for(var tokn in mapping) {
				tokens.push(tokn);
			}

			logger.debug('\tTokens %s ', JSON.stringify(tokens));
			
			var valid = true;
			
			for(i = 0; i < params.length; i++) {
				if(!post[params[i]]) {
					valid = false;
					break;
				}
			}
		
			if(!valid) {
				logger.notice("[400] " + req.method + " to " + req.url);
				logger.debug("something was missing.");
				logger.debug("expecting %s, got %s", JSON.stringify(params), JSON.stringify(post));
				res.writeHead(400, "Bad Request", {'Content-Type': 'text/plain'});
				res.end('400 - Bad Request');
			} else if(params.indexOf('token') != -1 && !mapping[post.token]) {
				logger.notice("[404] " + req.method + " to " + req.url);
				res.writeHead(404, "Not found", {'Content-Type': 'text/plain'});
				res.end('404 - Not found');
			} else {
				cb(post);
			}
		});
	} else {
		logger.notice("[405] " + req.method + " to " + req.url);
		res.writeHead(405, "Method not supported", {'Content-Type': 'text/plain'});
		res.end('405 - Method not supported');
	}
}

process.setuid('gtalk');
logger.notice('Starting gtalkjsonproxy on port 433');

client.smembers('clients', function(err, clients) {
	if(clients == null) return;
	
	clients.forEach(function (c) {
		client.get(c, function (err, data) {
			if(data) {
				var gtalk = require('./gtalk')(JSON.parse(data));

				gtalk.on('auth_failure', function(details) {
					logger.notice('unable to restore session for ' + gtalk.username);
					client.srem('clients', c);
				}).on('message', function(data) { logger.debug(function() { JSON.stringify(data); }); });

				gtalk.login(function() {
					logger.notice('session started ' + gtalk.username);

					mapping[gtalk.token] = gtalk;
					tokens[gtalk.username + ":" + gtalk.auth] = gtalk.token;
				});
			} else {
				client.srem('clients', c);
			}
		});
	});
});
