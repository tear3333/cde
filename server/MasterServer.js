// Imports
var http = require('http');
var webapp = require('./web/app');
var WebSocket = require('ws');
var fs = require("fs");
var ini = require('./modules/ini.js');

var GameServer = require('./GameServer');
var Commands = require('./modules/CommandList');

function MasterServer(selected) {
    this.gameServers = []; // List of gameservers this server is connected to

    this.realmID = 0; // An id of 0 is reserved for the master server
    this.lastID = 1; // DONT CHANGE
    this.selected = selected; // Selected server for commands

    this.commands = Commands.master; // Special set of commands for the master server

    this.config = {
        serverIP: "localhost",
        serverPort: 88,
        gameserverPort: 1500,
        updateTime: 60,
        regions: {
            "Cigar": 2
        },
    };

    this.REGIONS;

    this.info = {
        "MASTER_START": +new Date,
        "regions": {
            "US-Fremont": {
                "numPlayers": 3,
                "numRealms": 4,
                "numServers": 4
            },
        },
    };
}

module.exports = MasterServer;

var MS;

MasterServer.prototype.start = function() {
    function onError(error) {
        if (error.syscall !== 'listen') {
            throw error;
        }

        // handle specific listen errors with friendly messages
        switch (error.code) {
            case 'EACCES':
                console.log('\u001B[31m[Master]\u001B[0m ' + MS.config.serverPort + ' requires elevated privileges');
                process.exit(1);
                break;
            case 'EADDRINUSE':
                console.log('\u001B[31m[Master]\u001B[0m ' + MS.config.serverPort + ' is already in use');
                process.exit(1);
                break;
            default:
                throw error;
        }
    }

    function onListening() {
        var addr = MS.httpServer.address();
        var bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
        console.log('\u001B[31m[Master]\u001B[0m Master Server started at port ' + bind);
    }

    this.loadConfig();
    setInterval(this.onTick.bind(this), this.config.updateTime * 1000);
    this.onTick(); // Init
    MS = this;

    webapp.set('port', this.config.serverPort);
    webapp.setMaster(MS);
    this.httpServer = http.createServer(webapp);

    this.httpServer.listen(this.config.serverPort);
    this.httpServer.on('error', onError);
    this.httpServer.on('listening', onListening);
};

MasterServer.prototype.getName = function() {
    // Gets the name of this server. For use in the console
    return "\u001B[31m[Master]\u001B[0m";
};

MasterServer.prototype.getNextID = function() {
    return this.lastID++;
};

MasterServer.prototype.getServer = function(key) {
    var h = this.REGIONS[key][Math.floor(Math.random() * this.REGIONS[key].length)];
    return h ? h.ip : "0.0.0.0";
};

MasterServer.prototype.onTick = function() {
    this.info.regions = {};
    for (var key in this.REGIONS) {
        var json = {
            "numPlayers": this.getPlayerAmount(this.REGIONS[key]),
            "numRealms": this.REGIONS[key].length,
            "numServers": this.REGIONS[key].length
        };
        this.info.regions[key] = json;
    }
};

MasterServer.prototype.getPlayerAmount = function(array) {
    var a = 0;
    for (var i in array) {
        array[i].updatePlayers();
        a += array[i].stats.players;
    }
    return a;
};

MasterServer.prototype.loadConfig = function() {
    try {
        // Load the contents of the config file
        var load = ini.parse(fs.readFileSync('./masterserver.ini', 'utf-8'));

        // Replace all the default config's values with the loaded config's values
        for (var obj in load) {
            this.config[obj] = load[obj];
        }

        // Parse config
        this.REGIONS = JSON.parse(this.config.regions);
        for (var key in this.REGIONS) {
            var ii = this.REGIONS[key];
            this.REGIONS[key] = [];

            for (var i = 0; i < ii; i++) {
                this.createServer(key);
            }
        }

        // Intial selection
        if (this.gameServers[0]) {
            this.selected.server = this.gameServers[0].server;
        } else {
            // No game servers
            this.selected.server = this;
        }
    } catch (err) {
        // No config
        console.log(err);

        // Create a new config
        fs.writeFileSync('./masterserver.ini', ini.stringify(this.config));
    }
};

// Server management

MasterServer.prototype.addServer = function(ip, port, reg) {
    try {
        var ws = new WebSocket('ws://' + ip + ':' + port);
        var id;

        ws.on('error', function err(er) {
            console.log("\u001B[31m[Master]\u001B[0m Error connecting to a game server!");
        });

        ws.on('open', function open() {
            id = MS.getNextID(); // Get new ID
            ws.send('Hi' + id);
        });

        ws.on('message', function(data, flags) {
            if (data == 'Hello') {
                // Add to server list
                var h = new holderWS(MS, ws); // Server holder

                // Server stuff
                ws.holder = h;
                ws.realmID = id;

                // Add to region/server list
                MS.REGIONS[reg].push(h);
                h.server.region = reg; // Gameserver variable
                MS.gameServers[id - 1] = h;

                // Override
                ws.on('message', function(data, flags) {
                    if (data.charAt(0) == '[') {
                        console.log(data);
                    } else {
                        ws.holder.stats = JSON.parse(data);
                    }
                });
            }
        });

        ws.on('close', function close() {
            // Remove holder here
        });
    } catch (er) {
        console.log("\u001B[31m[Master]\u001B[0m Error connecting to a game server!");
        return;
    }


};

MasterServer.prototype.createServer = function(key, mode) {
    var id = this.getNextID(); // Get new ID

    var gs = new GameServer(id, './gameserver' + id + '.ini');
    gs.config.serverPort = this.config.gameserverPort + id;
    gs.config.serverGamemode = mode;
    gs.start(); // Start server

    // Holder
    var h = new holderGS(this, gs);

    // Command handler
    h.server.commands = Commands.list;

    // Add to region/server list
    this.REGIONS[key].push(h);
    h.server.region = key; // Gameserver variable
    this.gameServers[id - 1] = h;
};

MasterServer.prototype.removeServer = function(id, log) {
    // Game server
    var h = this.gameServers[id - 1];
    if (h) {
        this.gameServers.splice((id - 1), 1, null); // Replace with null to keep the array in order

        var index = this.REGIONS[h.server.region].indexOf(h);
        if (index > -1) { // Remove from region array
            this.REGIONS[h.server.region].splice(index, 1);
        }

        h.remove(); // Remove
        if (log) console.log(this.getName() + " Removed Game Server with ID: " + id);
    } else {
        if (log) console.log(this.getName() + " Invalid game server selected!");
    }
};

// Console commands

MasterServer.prototype.swap = function(id) {
    if (id == 0) {
        // User wants to slect the master server
        this.selected.server = this;
        console.log(this.getName() + " Switched to Master Server");
        return;
    }

    // Holder
    var h = this.gameServers[id - 1];
    if (h.server) {
        this.selected.server = h.server;
        console.log(this.getName() + " Switched to Game Server " + id);
    } else {
        console.log(this.getName() + " Invalid game server selected!");
    }
};

// Game Server Holder

function holderGS(masterServer, server) {
    this.server = server;
    this.master = masterServer;
    this.stats = {
        players: 0,
        max: 0,
        mode: "None",
    };

    this.ip = masterServer.config.serverIP + ":" + this.server.config.serverPort;

    this.updatePlayers = function() {
        this.stats = {
            players: this.server.clients.length,
            max: this.server.config.serverMaxConnections,
            mode: this.server.gameMode.name,
        };
    };

    this.remove = function() {
        this.server.socketServer.close(); // Remove
    };

    // Constructor
    this.updatePlayers();
}

// Remote Game Server holder

function holderWS(masterServer, server) {
    this.server = server;
    this.master = masterServer;
    this.stats = {
        players: 0,
        max: 0,
        mode: "None",
    };

    this.ip = this.server._socket.remoteAddress + ":" + this.server._socket.remotePort;

    this.updatePlayers = function() {

    };

    this.remove = function() {
        this.server.terminate();
    }

}