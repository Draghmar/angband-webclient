// var pty         = require('pty.js');
var pty         = require('node-pty');
var moment      = require('moment');
var ps          = require('ps-node');
var fs          = require('fs-extra');
var config      = require("./config");
var terminal    = require('term.js');

var lib         = {};

// holds current games played. User.name is the key
var matches     = {};

//miscellaneous terminals, currently used for game updates
// user.name is key 
var misc		= {};

// holds current socket connections
var metasockets = {};

//for more efficient file updates
var filelists = {};

var home        = process.env.CUSTOM_HOME || '/home/angband';
var localdb     = require("./localdb");
var games       = localdb.fetchGames();



lib.stats = function() {
	return {
		players: Object.keys(metasockets).length,
		games: Object.keys(matches).length
	}
}


lib.respond = function(user, msg) {
	if(msg.eventtype == 'chat') {
		chat(user, msg.content);
	} 
	else if(msg.eventtype == 'newgame'){
		if (typeof(matches[user.name]) != 'undefined') {
			closegame(user.name);
		} 
		else if(!(user.roles.indexOf("banned") !== -1)) {
			newgame(user,msg.content);
		}
	} 
	else if(msg.eventtype == 'connectplayer') {
		connectplayer(user.name);
	} 
	else if(msg.eventtype == 'subscribe') {
		subscribe(user, msg.content);
	}
	else if(msg.eventtype == 'unsubscribe') {
		unsubscribe(user, msg.content);
	}
	else if(msg.eventtype == 'gameinput') {
		var inputAsString = JSON.stringify(msg.content);
		if(typeof(matches[user.name]) != 'undefined' && inputAsString != '"\\u001a"'){
			matches[user.name].term.write(msg.content);
			matches[user.name].idle = false;
		}
	}
	else if(msg.eventtype == 'updateinput') {
		if(typeof(misc[user.name]) != 'undefined'){
			misc[user.name].write(msg.content);
		}
	}
	else if(msg.eventtype == 'update') {
		updategame(user, msg.content);
	}
	else if(msg.eventtype == 'deletefile') {
		handleDeleteRequest(user, msg.content);
	}
}

function chat(user, message){
	var response = { 
		eventtype: "chat",
		content: { 
			user: user.name,
			message: message,
			extra: user.roles,
			timestamp: new Date()
		}
	};

	// if this is a command message from devs or maintainers (starts with / followed by command) then do what needs to be done
	if(message[0] === "/" && (user.roles.indexOf("dev") !== -1 || user.roles.indexOf("maintainer") !== -1)) {
		var command = message.match(/\/\w+/)[0];
		var msg = message.replace(command + " ", "");
		
		response.eventtype = "systemannounce";
		
		// announce text to all users as system message
		if(command === "/announce" && command != msg && user.roles.indexOf("dev") !== -1) {
			response.content = msg;
			localdb.pushMessage("--system--", msg);
			announce(response);
		}
		else if(command === "/addrole" && command != msg && user.roles.indexOf("dev") !== -1) {
			var role = msg.match(/\w+/)[0];
			var recipient = msg.replace(role + " ", "");
			var roles = localdb.addRole(role,recipient);
			response.content = "user "+recipient+" has roles "+JSON.stringify(roles);
			metasockets[user.name].send(JSON.stringify(response));
			
		}
		else if(command === "/refresh" && user.roles.indexOf("dev") !== -1){
			localdb.refresh();
			response.content = "db refreshed";
			metasockets[user.name].send(JSON.stringify(response));
		}
		else if(command === "/rename" && command != msg) {
			var game = msg.match(/[\w-]+/)[0];
			var gameinfo = getgameinfo(game);
			console.log(msg);
			var longname = msg.replace(game + " ", "");
			if(typeof(gameinfo.owner)!= 'undefined' && gameinfo.owner == user.name) {
				localdb.setVersionString(game,longname);
				response.content = game+" renamed to "+longname;
				localdb.refresh();
				games = localdb.fetchGames();
			} else {
				response.content = "You do not have the authority to rename "+game;
			}
			metasockets[user.name].send(JSON.stringify(response));
		}
		else {
			response.content = "unknown command or incorrect syntax";
			metasockets[user.name].send(JSON.stringify(response));
		}

	}
	else {
		if (!(user.roles.indexOf("mute") !== -1)) {
			localdb.pushMessage(user, message);
			announce(response);
		} 
		else {
			metasockets[user.name].send(JSON.stringify(response));
		}
	}	
}

function checkForDeath(player){
	if (!isalive(player,matches[player].game)) {
		if (matches[player].alive) {
			var killedBy = getcharinfo(player,matches[player].game).killedBy
			var msg = player+" was killed by "+killedBy;
			if (killedBy == "Ripe Old Age") {
				msg+=". Long live "+player+"!";
				localdb.addRole("winner",player);
			}
			localdb.pushMessage("--deathangel--", msg);
			announce({eventtype:"deathannounce",content:msg});
		}
	}
	matches[player].alive=isalive(player,matches[player].game);
}

function announce(message){
	for (var i in metasockets){
		try {
			metasockets[i].send(JSON.stringify(message));
		}
		catch (ex) {
			// The WebSocket is not open, ignore
		}
	}
}

//some get functions
function getmatchlist(matches) {
	var livematches = {};
	for (var i in matches) {
		var charinfo = getcharinfo(i, matches[i].game);
		livematches[i] = {
			game       : matches[i].game,
			idletime   : matches[i].idletime,
			cLvl       : charinfo.cLvl,
			race       : charinfo.race,
			subrace    : charinfo.subrace,
			class      : charinfo.class,
			dimensions : {rows: matches[i].dimensions.rows, cols: matches[i].dimensions.cols} 
		};
	}
	return livematches;
}


//check player alive status for recording purposes
function isalive(user,game){
	var alive = true;
	var charinfo = getcharinfo(user,game);
	if (charinfo.isAlive == "0" || charinfo.isDead == "1") {
		alive = false;
	}
	return alive;
}


function getcharinfo(user, game) {
	var dirpath = home+'/user/'+user+'/'+game;
	fs.ensureDirSync(dirpath);
	var files = fs.readdirSync(dirpath);
	var charinfo = {};
	if (files.includes('CharOutput.txt')) {
		var json=fs.readFileSync(dirpath + '/CharOutput.txt','utf8');
		json = json.replace(/\n/gm,"\n\"");
		json = json.replace(/:/gm,'":');
		json = json.replace(/"{/gm,'{');
		json = json.replace(/"}/gm,'}');
		try {
			charinfo=JSON.parse(json);
		} 
		catch (ex) {
		}
	}
	return charinfo;
}


function getfilelist(name) {
	var files = {};
	var users = fs.readdirSync(home+'/user/');
	if (users.includes(name)){
		var path = home+'/user/'+name+'/';
		fs.ensureDirSync(path);
		var ls = fs.readdirSync(path);
		for (var i in games){
			var dumps = [];
			if (games[i].name.match(/^[a-zA-Z0-9-_]+$/)){
				fs.ensureDirSync(path+games[i].name);
				var varfiles = fs.readdirSync(path+games[i].name);
				for (var j in varfiles){
					dumps.push(varfiles[j]);
				}
				files[games[i].name]=dumps;
			}
		}
		files.name=name;
	}
	return files;
}

function handleDeleteRequest(user,request){
	var filedir = home;
	var filename;
	if (request.filetype=='usergenerated'){
		filedir += '/user/'+user.name+'/'+request.game+'/';
		filename = request.specifier;
	} else if (request.filetype=='ownsave') {
		filedir += '/games/'+request.game+'/lib/save/'
		fs.ensureDirSync(filedir);
		var ls = fs.readdirSync(filedir);
		if (ls.includes(user.name)) {
			filename=user.name;
		} else if (ls.includes('1000.'+user.name)) {
			filename='1000.'+user.name;
		} else {
			return "savefile does not exist";
		}
		fs.copyFileSync(filedir+filename,home+'/user/'+user.name+'/'+request.game+'/'+user.name);
	} else if (request.filetype=='usersave') {
		if (getgameinfo(request.game).owner == user.name) {
			filedir += '/games/'+game+'/lib/save/'
			fs.ensureDirSync(filedir);
			var ls = fs.readdirSync(filedir);
			if (ls.includes(request.specifier)) {
				filename=request.specifier;
			} else {
				return "savefile does not exist";
			}
		} else {
			return "you cannot delete savefiles for "+request.game;
		}
	} else {
		return "bad delete request"
	}
	fs.ensureDirSync(filedir);
	var ls = fs.readdirSync(filedir);
	if (ls.includes(filename)) {
		fs.unlinkSync(filedir+filename);
	}
	try {
		metasockets[user.name].send(JSON.stringify({eventtype: 'fileupdate', content: getfilelist(user.name)}));
	} 
	catch (ex) {
		// The WebSocket is not open, ignore
	}
}

function getgamelist(player) {
	var gamelist = [];
	for (var i in games){
		var savexists=fs.existsSync(home+'/games/'+games[i].name+'/lib/save/'+player);
		if (fs.existsSync(home+'/games/'+games[i].name+'/lib/save/1000.'+player)) savexists=true;
		gamelist.push({
			name:games[i].name, 
			longname:games[i].longname, 
			desc:games[i].desc,
			owner:games[i].owner,
			savexists:savexists
		});
	}
	gamelist.sort(function(a, b) {
	  var nameA = a.name.toUpperCase(); // ignore upper and lowercase
	  var nameB = b.name.toUpperCase(); // ignore upper and lowercase
	  if (nameA < nameB) {
		return -1;
	  }
	  if (nameA > nameB) {
		return 1;
	  }
	  // names must be equal
	  return 0;
	});
	return gamelist;
}


function getgameinfo(game) {
	var info = {};
	for (var i in games){
		if (games[i].name==game) {
			info.restrict_paths=games[i].restrict_paths;
			info.data_paths=games[i].data_paths;
			info.args=games[i].args;
			info.owner=games[i].owner;
		}
	}
	return info;
}


function newgame(user, msg) {
	var game = msg.game;
	var gameinfo = getgameinfo(game);
	var panels = msg.panels;
	var dimensions = msg.dimensions;
	var asciiwalls = msg.walls;
	var player = user.name;
	var alive = isalive(player,game);
	var compgame = 'silq';
	var compnumber = '217';
	var panelargs = ['-b'];
	console.log(`starting new game: user=${user.name} dimensions=${dimensions.cols}x${dimensions.rows}`);
	if(panels > 1) {
		if (game == 'poschengband' || game == 'elliposchengband' || game == 'composband' || game == 'frogcomposband') {
			panelargs = ['-right','40x*','-bottom','*x8'];
		} 
		else {
			panelargs = ['-n'+panels];
		}
	}
	var path = home + '/games/' + game + '/' + game;
	var args = [];
	var terminfo = 'xterm-256color';
	if(game == 'umoria') {
		args.push(home + '/games/' + game + '/' + user.name);
	} 
	else {
		if (game == 'competition') {
			args.push('-u'+compnumber+'-'+user.name);
		} 
		else {
			args.push('-u'+user.name);
		}
		if (game == 'competition') {
			args.push('-duser='+home+'/user/'+user.name+'/'+compgame);
		} 
		else if (gameinfo.restrict_paths){
			args.push('-d'+home+'/user/'+user.name+'/'+game);
		} 
		else {
			args.push('-duser='+home+'/user/'+user.name+'/'+game);
		}
		for (var i in gameinfo.args) {
			args.push('-'+gameinfo.args[i]);
		}
		args.push('-mgcu');
		args.push('--');
		for (var i in panelargs){
			args.push(panelargs[i]);
		}
	}
	if (msg.walls) 
		args.push('-a');
	var termdesc = {};
	if (game == 'competition') {
		var newattempt = true;
		var newtty = false;
		var savegames = fs.readdirSync(home+'/'+compgame+'/lib/save/');
		if (savegames.includes('1002.'+compnumber+''+user.name)){
			newattempt = !isalive(user.name,compgame);
		}
		fs.ensureDirSync(home+'/user/'+user.name);
		var ttydir = fs.readdirSync(home+'/ttyrec');
		var ttyfile = home+'/ttyrec/'+compnumber+'-'+user.name+'.ttyrec';
		if (ttydir.includes(ttyfile)){
			newtty=true;
		}
		var command = home+'/games/'+compgame+' '+args.join(' ');
		path = 'ttyrec';
		args = [
			'-e',
			command,
			ttyfile
		];
		if (!newattempt) {
			if (!newtty) 
				args.unshift('-a');
		} 
		else {
			fs.copySync(home+'/games/'+compgame+'/lib/save/1002.'+compnumber, home+'/games/'+compgame+'/lib/save/1002.'+compnumber+''+user.name);
		}
	}
	termdesc = {
		path     : path,
		args     : args,
		terminfo : terminfo
	};
	try {
		var term_opts = {
			name              : termdesc.terminfo,
			cols              : parseInt(dimensions.cols),
			rows              : parseInt(dimensions.rows),
			cwd               : home + '/games/' + game,
			applicationCursor : true
		};
		var term = pty.fork(termdesc.path,termdesc.args, term_opts);
		term.on('data', function(data) {
			try {
				metasockets[player].send(JSON.stringify({eventtype: 'owngameoutput', content: data}));
			} 
			catch (ex) {
				// The WebSocket is not open, ignore
			}
			if (typeof(matches[player])!='undefined') 
				for (var i in matches[player].spectators) {
					try {
						metasockets[matches[player].spectators[i]].send(JSON.stringify({
							eventtype: 'gameoutput',
							content: {
								player :player,
								data   :data
							}
						}));
					} 
					catch (ex) {
						// The WebSocket is not open, ignore
					}
				}
	/* 		if (typeof(matches[player].termcache)!='undefined') {
				matches[player].termcache.write(data);
			} */
		});
		term.on('close', function(data) {
			closegame(user.name);
		});
		
		matches[user.name] = {
			term: term,
			game: game,
			idle: false,
			idletime: 0,
			alive: alive,
			spectators: [],
			dimensions: dimensions
		};
		
		announce({eventtype: 'matchupdate', content: getmatchlist(matches)});
	} 
	catch(ex) {
		console.log('we usually crash here, now we should not any more.');
		console.error(ex);
	}
	/*var termcache = new terminal.Terminal({
		termName: 'xterm-256color',
		colors: terminal.Terminal.xtermColors,
		cols: dimensions.cols,
		rows: dimensions.rows,
		cursorBlink: false,
		scrollBottom: dimensions.rows
	});*/
}

function updategame(user, msg) {
	var gameinfo = getgameinfo(msg.game);
	console.log(`update attempt by user ${user.name} of ${msg.game}`);
	if(typeof(gameinfo.owner)!= 'undefined' && gameinfo.owner == user.name){
	console.log(`proceeding with update`);
		var path = process.cwd() + '/updategame.sh';
		termdesc = {
			path     : path,
			args     : [msg.game],
			terminfo : 'xterm-256color'
		};
		try {
			var term_opts = {
				name              : termdesc.terminfo,
				cols              : parseInt(msg.dimensions.cols),
				rows              : parseInt(msg.dimensions.rows),
				cwd               : process.env.HOME,
				applicationCursor : true
			};
			var term = pty.fork(termdesc.path,termdesc.args, term_opts);
			term.on('data', function(data) {
				try {
					metasockets[user.name].send(JSON.stringify({eventtype: 'updateoutput', content: data}));
				} 
				catch (ex) {
					// The WebSocket is not open, ignore
				}
			});
			term.on('close', function(data) {
				try {
					metasockets[user.name].send(JSON.stringify({eventtype: 'updateover', content: []}));
				} 
				catch (ex) {
					// The WebSocket is not open, ignore
				}
				announce({eventtype:"system",content:msg.game+" has been updated by "+user.name});
			});
			misc[user.name]=term;
		} 
		catch(ex) {
			console.log('update failure.');
			console.error(ex);
		}	
	}
}

function closegame(player){
	if (typeof(matches[player])!='undefined'){
		//check for player death
		checkForDeath(player);
		//kill the process if it hasn't already
		//horrific reverse engineering hack here
		var term = matches[player].term;
		if (matches[player].game == 'competition'){
			var gamepid = parseInt(term.pid) + 3;
		} 
		else {
			var gamepid=term.pid;
		}
		ps.lookup({ pid: gamepid }, function(err, resultList ) {
			if (err) {
				console.log( err );
			}
			var process = resultList[ 0 ];
			if( process ){
				setTimeout(function() {
					try {
						ps.kill( gamepid, function( err ) {
							if (err) 
								return console.log( err );
							try {
								term.kill();
								console.log( 'Process %s did not exit and has been forcibly killed!', gamepid );
							}
							catch(e) { console.error(e); }
						});
					} 
					catch(ex) {
						console.error(ex);
					}
				},500);
			} 
			else {
				console.log( 'Process %s was not found, expect user exited cleanly.',player );
			}
			try {
				metasockets[player].send(JSON.stringify({eventtype: 'gameover', content: []}));
				metasockets[player].send(JSON.stringify({eventtype: 'fileupdate', content: getfilelist(player)}));
				metasockets[player].send(JSON.stringify({eventtype: 'gamelist', content: getgamelist(player)}));
			} 
			catch (ex) {
				// The WebSocket is not open, ignore
			}
			// Clean things up
			delete matches[player]; 
			announce({eventtype: 'matchupdate', content: getmatchlist(matches)});
		});
	}
}


function subscribe(user, message) {
	var player = message.player;
	var spectator = user.name;
	if (typeof(matches[player]) != 'undefined' && typeof(matches[player].term) != 'undefined' && typeof(user.name) != 'undefined') {
		if(metasockets[player]) {
			metasockets[player].send(JSON.stringify({eventtype: 'systemannounce', content: spectator + " is now watching"}));
			matches[player].spectators.push(spectator);
		}
		/* try {
			metasockets[spectator].send(JSON.stringify({eventtype: 'gameoutputcache', content: {player:player,term:matches[player].termcache}}));
		} catch (ex) {
			// The WebSocket is not open, ignore
		} */
	}
}


function unsubscribe(user, message) {
	var player = message.player;
	var spectator = user.name;
	if (typeof(matches[player]) != 'undefined' && typeof(matches[player].term) != 'undefined' && typeof(user.name) != 'undefined') {
		if(metasockets[player]) {
			metasockets[player].send(JSON.stringify({eventtype: 'systemannounce', content: spectator + " stopped watching your game"}));
			var index = matches[player].spectators.indexOf(spectator);
			if(index !== -1)
				matches[player].spectators.splice(index, 1);
		}
	}
}



// ===================================================================
// EXPORTED FUNCTIONS
// ===================================================================
lib.welcome = function(user,ws) {
	
	metasockets[user.name] = ws;
	var player = user.name;
	
	//keep track of file list
	filelists[user.name] = getfilelist(user.name);
	
	//send some info to the user upon connecting
	try {
		var last_chat_messages = localdb.readMessages(config.chat_last_messages);
		metasockets[user.name].send(JSON.stringify({eventtype: 'gamelist', content: getgamelist(user.name)}));
		metasockets[user.name].send(JSON.stringify({eventtype: 'populate_chat', content: last_chat_messages}));
		metasockets[user.name].send(JSON.stringify({eventtype: 'matchupdate', content: getmatchlist(matches)}));
		metasockets[user.name].send(JSON.stringify({eventtype: 'fileupdate', content: filelists[user.name]}));
		metasockets[user.name].send(JSON.stringify({eventtype: 'usercount', content: Object.keys(metasockets)}));
	} 
	catch (ex) {
		// The WebSocket is not open, ignore
	}
	

	// push arrival event to chat database
	var diff = moment().diff(user.last_connected, "seconds");
	if(!user.last_connected || diff > 30) {
		// localdb.pushMessage("--system--", `${user.name} has joined the chat`);
		var last_connected = localdb.updateLastConnected(user.name);
		user.last_connected = last_connected;
	}

	//announce their arrival
	for (var i in metasockets){
		try {
			metasockets[i].send(JSON.stringify({
				eventtype: 'usercount', content: Object.keys(metasockets)
			}));
			// if(i !== user.name) {
			// 	metasockets[i].send(JSON.stringify({
			// 		eventtype: 'systemannounce', content: `${user.name} has joined the chat`
			// 	}));
			// }
		} 
		catch (ex) {
			// The WebSocket is not open, ignore
		}
	}
	
	//listen for inputs
	metasockets[user.name].on('message', function(message) {
		var msg = JSON.parse(message);
		lib.respond(user,msg);
	});
	
	//bid farewell
	metasockets[user.name].once('close', function() {
		if (player!='borg'){
			console.log('Closing socket for ' + player);
			//we need to check there's a match in the first place
			if (typeof(matches[player])!='undefined'){
				closegame(player);
			} 
			for (var i in matches) {
				if (typeof(matches[i])!='undefined'&&matches[i].spectators.includes(user.name)) {
					delete matches[i].spectators[matches[i].spectators.indexOf(user.name)];
				}
			}
		}
		delete metasockets[user.name];

		// push departure event to chat database
		var diff = moment().diff(user.last_disconnected, "seconds");
		if(!user.last_disconnected || diff > 30) {
			// localdb.pushMessage("--system--", `${user.name} has left the chat`);
			var last_disconnected = localdb.updateLastDisconnected(user.name);
			user.last_disconnected = last_disconnected;
		}

		//announce the departure
		for (var i in metasockets) {
			try {
				metasockets[i].send(JSON.stringify({eventtype: 'usercount', content: Object.keys(metasockets)}));
				// if(i !== user.name) {
				// 	metasockets[i].send(JSON.stringify({
				// 		eventtype: 'systemannounce', content: `${user.name} has left the chat`
				// 	}));
				// }
			} 
			catch (ex) {
				// The WebSocket is not open, ignore
			}
		}
	});
}

//also checks for file diffs in lieu of fs.watch
lib.keepalive = function(){
	var matchlist=getmatchlist(matches);
	var fileupdate=(getfilelist(i)!=filelists[i]);
	filelists[i]=getfilelist(i);
	for (var i in matches) {
		if (matches[i].idle) {
			matches[i].idletime++;
		} else {
			matches[i].idletime=0;
		}
		matches[i].idle=true;
		if (matches[i].idletime>60) {
			closegame(i);
		} 
		
		checkForDeath(i);
	}
	for (var i in metasockets) {
		try {
			metasockets[i].ping();
			metasockets[i].send(JSON.stringify({eventtype: 'matchupdate', content: matchlist}));
			if (fileupdate) metasockets[i].send(JSON.stringify({eventtype: 'fileupdate', content: getfilelist(i)}));
		} catch (ex) {
			// The WebSocket is not open, ignore
		}
	}
}

module.exports = lib;
