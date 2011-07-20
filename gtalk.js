var logger = require('./log').log('gtalk');
var redis = require("redis"),
    client = redis.createClient();

function gtalk(token, username, auth) {
	if(typeof(token) == 'object') {
		this.token = token.token;
		this.username = token.username;
		this.auth = token.auth;
		this.callback = token.callback;
	} else {
		this.token = token;
		this.username = username;
		this.auth = auth;
		this.callback = undefined;
	}
	
	this.server = username.split('@')[1];
	this.logged_in = false;
	this.jid = undefined;
	this.sock = undefined;
	this.rosterList = {};
	this.sendRaw = true;
};

gtalk.prototype = new process.EventEmitter();

gtalk.prototype.login = function(cb) {
	var base64_encode = require("base64").encode;
	var Buffer = require('buffer').Buffer;
	var xml2js = require('xml2js');

	var s = require("net").createConnection(5222, 'talk.google.com');
	var self = this;
	
	s.on('connect', function() {
		s.write("<?xml version='1.0'?>\n<stream:stream to='" + self.server + "' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>");
	}).on('data', function(data) {
		var str = data.toString('utf8');
	
		if(str.indexOf('stream:features') != -1) {
			s.write("<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls' />");
		} else if(str.indexOf('proceed') != -1) {
			s.removeAllListeners('data');
		
			require('./starttls')(s, {}, function(ss) {
				if(!ss.authorized) {
					self.emit('auth_failure', ss.authorizationError);
					ss.destroy();
					return;
				}
			
				ss.write("<stream:stream to='" + self.server + "' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>");
				self.sock = ss;
				
				var expecting_roster = false;
				var roster_text = "";
			
				ss.on('data', function(data) {
					var str = data.toString('utf8');
				
					if(str.indexOf('stream:features') != -1) {
						if(self.logged_in) {
							ss.write("<iq type='set' id='bind_resource'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><resource>wpmango</resource></bind></iq>");
						} else {
							var token = base64_encode(new Buffer('\u0000' + self.username + '\u0000' + self.auth));
					
							ss.write("<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='X-GOOGLE-TOKEN'>" + token + "</auth>");
						}
					} else if(str.indexOf('success') != -1) {
						self.logged_in = true;
						
						ss.write("<stream:stream to='" + self.server + "' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>");
						
						client.sadd('clients', 'client:' + self.token);
						self.persist();
					} else if(str.indexOf('failure') != -1) {
						self.emit('auth_failure', str);
						logger.debug('auth_failure: %s', str);
						self.logout();
					} else if(str.indexOf('iq') != -1) {
						if(str.indexOf('bind_resource') != -1) {
							self.jid = str.match(/<jid>([^>]*)<\/jid>/)[1];
							
							ss.write("<iq to='" + self.server + "' type='set' id='session'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>");
						} else if(str.indexOf('session') != -1) {
							ss.write("<iq from='" + self.jid + "' type='get' id='roster'><query xmlns='jabber:iq:roster'/></iq>");
							expecting_roster = true;
						} else if(expecting_roster) {
							roster_text += str;
							
							if(str.indexOf('</iq>') == -1) {
								return;
							}
							
							var roster_parser = new xml2js.Parser();
							
							roster_parser.addListener('end', function(result) {
								if(result.query.item.length) {
									for(i = 0; i < result.query.item.length; i++) {
										var ros = self.stripRoster(result.query.item[i]);
										self.rosterList[ros.jid] = ros;
									}
								} else {
									var ros = self.stripRoster(result.query.item);
									self.rosterList[ros.jid] = ros;
								}
							
								if(cb) cb();
							});
							
							roster_parser.parseString(roster_text);
							
							ss.removeAllListeners('data');
							ss.addListener('data', function(d) {
								var parser = new xml2js.Parser();
								
								parser.addListener('end', function(result) {
									if(result.presence) {
										if(result.presence.length) {
											for(i = 0; i < result.presence.length; i++) {
												self.emit('presence', self.stripPresence(result.presence[i]));
											}
										} else {
											self.emit('presence', self.stripPresence(result.presence));
										}
									} else if(result.message) {
										if(result.message.length) {
											for(i = 0; i < result.message.length; i++) {
											self.emit('message', self.stripMessage(result.message[i]));
											}
										} else {
											self.emit('message', self.stripMessage(result.message));
										}
									}
								});
								
								parser.parseString("<x>" + d.toString('utf8') + "</x>");
							});
							ss.write("<presence/>");
						}
					}
				});
			});
		}
	});

	var pushNotification = function(data) {
		if(!self.callback) {
			client.rpush('messages:' + self.username, JSON.stringify(data));
			return;
		}

		if(self.sendRaw) {
			self.post(self.callback, JSON.stringify(data), function(res) {
				var body = "";
				res.on('data', function(chunk) {
					body += chunk;
				}).on('end', function() {
					logger.debug('mira los headers: ' + JSON.stringify(res.headers));
					//"x-notificationstatus":"Suppressed"
	
					if(res.statusCode != 200) {
						logger.debug('error, disabling callback!');
						self.callback = undefined;
						
						self.persist();
					} else if(res.headers['x-notificationstatus'] == 'Suppressed') {
						// switch to toast NOW
						logger.debug('notification suppressed, sending toast instead');
						self.sendRaw = false;
						pushNotification(data);
					} else {
						logger.debug('another message sent: %s',  body);
					}
				});
			}, function(e) {
				logger.debug('error, disabling callback');
				logger.debug(e);
				self.callback = undefined;
				
				self.persist();
			});
		} else if(data.body) {
			var name = data.from.split('/')[0];
			
			client.rpush('messages:' + self.username, JSON.stringify(data));

			if(self.rosterList[name] && self.rosterList[name].name) {
				name = self.rosterList[name].name;
			}

			logger.debug('the data %s', JSON.stringify(data));
			logger.debug('the name %s', name);

			var toast = '<?xml version="1.0" encoding="utf-8"?>\n<wp:Notification xmlns:wp="WPNotification"><wp:Toast>';
			toast += '<wp:Text1>' + xmlEscape(name) + '</wp:Text1><wp:Text2>' + xmlEscape(data.body) + '</wp:Text2>';
			toast += '<wp:Param>/Chat.xaml</wp:Param></wp:Toast></wp:Notification>';

			logger.debug('gonna send some toast! %s', toast);

			self.post(self.callback, toast, function(res) {
				var body = "";
				res.on('data', function(chunk) {
					body += chunk;
				}).on('end', function() {
					logger.debug('mira los headers: ' + JSON.stringify(res.headers));
	
					if(res.statusCode != 200) {
						logger.debug('error, disabling callback!');
						self.callback = undefined;
					} else {
						logger.debug('another message sent: %s',  body);
					}
				});
			}, function(e) {
				logger.debug('error, disabling callback');
				logger.debug(e);
				self.callback = undefined;
			}, {'X-NotificationClass': '2', 'X-WindowsPhone-Target': 'toast', 'Content-Type': 'text/xml'});
		}
	};
	this.on('message', pushNotification);
	/*
	this.on('presence', function(data) {
		if(!self.callback) return;

		self.post(self.callback, JSON.stringify(data), function(res) {
			res.on('data', function(chunk) {  console.log('es acá?'); console.log(logger); logger.debug(JSON.stringify(res.headers)); logger.debug(chunk.toString()); logger.debug(""); });
		}, function(e) {
			console.log('o acá?'); console.log(logger);
			
			logger.debug('error, disabling callback');
			logger.debug(e);
			self.callback = undefined;
		}, {'X-NotificationClass': '13'});
	});
	*/
};

gtalk.prototype.stripMessage = function(m) {
	var msg = {from: m['@'].from, time: new Date().getTime()};
	
	if(m['@'].type) msg.type = m['@'].type;
	if(m.body) msg.body = m.body;
	if(m['nos:x']) msg.otr = m['nos:x']['@'].value == 'enabled';
	
	this.rosterList[msg.from.split("/")[0]].otr = msg.otr;
	
	return msg;
};

gtalk.prototype.stripPresence = function(p) {
	var pre = {jid: p['@'].from};
	
	if(p['@'].type) pre.type = p['@'].type;
	if(p.show) pre.show = p.show;
	if(p.status && typeof(p.status) == 'string') pre.status = p.status;
	if(p.x && p.x.photo) pre.photo = p.x.photo;
	
	if(!this.rosterList[pre.jid.split("/")[0]]) {
		this.rosterList[pre.jid.split("/")[0]] = pre;
	} else {
		var orig = this.rosterList[pre.jid.split("/")[0]];
		
		for(var x in pre) {
			if(typeof(pre[x]) == 'function') continue;
			
			orig[x] = pre[x];
		}
		
		if(!pre.type && orig.type) orig.type = undefined;
	}
	
	return pre;
};

gtalk.prototype.stripRoster = function(r) {
	var ros = {jid: r['@'].jid, type: 'unavailable'};
	
	if(r['@'].name) ros.name = r['@'].name;
	
	return ros;
};

gtalk.prototype.send = function(data, cb) {
	this.sock.write(data, cb);
};

gtalk.prototype.post = function(url, data, cb, ecb, extraHeaders) {
	var params = url.match(/(https?):\/\/([a-z0-9.-]+)(?::([0-9]+))?(\/.*)?$/);
	
	var buf = new Buffer(data);

	var options = {
		host: params[2],
		port: parseInt(params[3]),
		path: params[4],
		method: 'POST',
		headers: {'X-NotificationClass': '3', 'Content-Type': 'text/json', 'Content-Length': buf.length}
	};
	
	if(extraHeaders) {
		for(var h in extraHeaders) {
			if(typeof extraHeaders[h] != 'string') continue;
			
			options.headers[h] = extraHeaders[h];
		}
	}

	if(!options.port) {
		if(params[1] == 'http') options.port = 80;
		else options.port = 443;
	}

	if(!options.path) {
		options.path = '/';
	}

	if(params[1] == 'http') require('http').request(options, cb).on('error', ecb).end(buf);
	else require('https').request(options, cb).on('error', ecb).end(buf);
};

gtalk.prototype.message = function(to, body, cb) {
	var jid = to;
	
	if(jid.indexOf('/')) {
		jid = jid.split("/")[0]
	}
	
	if(this.rosterList[jid].otr) {
		this.send("<message from='" + xmlEscape(this.jid) + "' to='" + xmlEscape(to) + "'><body>" + xmlEscape(body) + "</body><nos:x value='enabled' xmlns:nos='google:nosave' /><arc:record otr='true' xmlns:arc='http://jabber.org/protocol/archive' /></message>", cb);
	} else {
		this.send("<message from='" + xmlEscape(this.jid) + "' to='" + xmlEscape(to) + "'><body>" + xmlEscape(body) + "</body><nos:x value='disabled' xmlns:nos='google:nosave' /><arc:record otr='false' xmlns:arc='http://jabber.org/protocol/archive' /></message>", cb);
	}
};

gtalk.prototype.roster = function(cb) {
	for(var username in this.rosterList) {
		if(typeof(username) != 'string' || typeof(this.rosterList[username]) == 'function') continue;
		
		cb(this.rosterList[username]);
	}
	
	cb(null);
};

gtalk.prototype.register = function(url) {
	this.callback = url;
	this.sendRaw = true;
	this.persist();
};

gtalk.prototype.messageQueue = function(cb) {
	client.lrange('messages:' + this.username, 0, -1, function(err, messages) {
		if(messages == null) return;
		
		messages.forEach(cb);
		
		cb(null);
		
		client.ltrim(messages.length + 1, -1);
	});
};

gtalk.prototype.logout = function() {
	var self = this;
	
	this.send("</stream:stream>", function() {
		self.sock.destroy();
	});
	
	client.srem('clients', 'client:' + self.token);
	client.del('client:' + self.token);
};

gtalk.prototype.persist = function() {
	client.set('client:' + this.token, JSON.stringify({
		token: this.token,
		username: this.username,
		auth: this.auth,
		callback: this.callback
	}));
};

function xmlEscape(str) {
	return str.replace('&', '&amp;')
		.replace("'", '&apos;')
		.replace('"', '&quot;')
		.replace('<', '&lt;')
		.replace('>', '&gt;');
}

module.exports = function(username, auth) {
	return new gtalk(username, auth);
};
