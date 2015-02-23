var fs    = require('fs'),
    path  = require('path'),
    mime  = require('mime'),
    http  = require('http'),
    https = require('https'),
    url   = require('url'),
    zlib  = require('zlib'),
    util  = require('util');
var utils              = require('./utils'),
    serveStaticFile    = utils.serveStaticFile,
    extendObject       = utils.extendObject,
    proxyRequest       = utils.proxyRequest,
    Response           = utils.Response,
    deprecationWarning = utils.deprecationWarning;
var exceptions = require('./exceptions'),
    InvalidRoboHydraHeadException =
        exceptions.InvalidRoboHydraHeadException,
    InvalidRoboHydraHeadStateException =
        exceptions.InvalidRoboHydraHeadStateException;

// These properties are always there, impliticly. They make sense in
// all heads, and they're easy to forget and annoying to explicitly
// mention every time.
var IMPLICIT_OPTIONAL_PROPS = ['name',
                               'detached',
                               {name: 'method', defaultValue: '*'},
                               {name: 'hostname', defaultValue: '.*'},
                               {name: 'reset', defaultValue: function() {}}];

/*

 Notes on creating RoboHydraHead* classes:

 * By convention, all classes set a 'parent' property.

 * By convention, all classes have a 'type' property with a simple
   name for the class. This is used in the admin UI.

 * All classes have an array of mandatory properties and optional
   properties in 'mandatoryProperties' and 'optionalProperties'.

 * Classes should always provide a set of default properties in the
   constructor if no argument is passed at all, to ease the creation
   of other classes inheriting from it.

 * All class constructors call "importProperties" with the current
   class and the property object received as a parameter, to copy the
   relevant properties to the object, and check that there are no
   invalid properties.

 * All class constructors call "inherit" with the parent class (always
   available as CurrentClass.parent, see above) with the property
   object received as a parameter, plus any extra properties to be
   passed to the parent class.

 */

function RoboHydraHead(props) {
    // If you don't pass props at all, created a "generic", valid
    // RoboHydra head. This is useful for inheritance and for when you
    // don't really care about the behaviour of the head (you just
    // want one created)
    props = props || {path: '/.*', handler: function(_, res) {res.end();}};

    this.type = 'generic';
    this.importProperties(RoboHydraHead, props);

    var self = this;
    this._attached = !props.detached;
    this.requestParamNames = [];
    this._methods = (util.isArray(this.method) ? this.method : [this.method]).
        map(function(m) { return m.toUpperCase(); });
    this.path = this.normalizePath(props.path || '/.*').
            replace(/:(\w+)/g,
                    function(_, name) {
                        self.requestParamNames.push(name);
                        return '([^/]+)';
                    });
    if (typeof this.reset !== 'function') {
        throw new InvalidRoboHydraHeadException("Property 'reset' must be a function");
    }
    this.reset();
}
RoboHydraHead.mandatoryProperties = ['path', 'handler'];
RoboHydraHead.optionalProperties = [].concat(IMPLICIT_OPTIONAL_PROPS);
RoboHydraHead.prototype.importProperties = function(classObject, props) {
    function propertyExistsPredicate(p) {
        return function(propDef) {
            if (typeof propDef === 'object') {
                return propDef.name === p;
            } else {
                return propDef === p;
            }
        };
    }

    var self = this;

    // Mandatory properties
    classObject.mandatoryProperties.forEach(function(p) {
        if (props[p] === undefined) {
            throw new InvalidRoboHydraHeadException("Missing mandatory property '" + p + "'");
        }
        self[p] = props[p];
    });

    // Optional properties
    classObject.optionalProperties.forEach(function(p) {
        var propName         = (typeof p === 'object') ? p.name : p,
            propDefaultValue = (typeof p === 'object') ? p.defaultValue :
                                                         undefined;
        self[propName] = (props[propName] !== undefined) ?
            props[propName] :
            propDefaultValue;
    });

    // Check that there aren't any extra properties
    for (var p in props) {
        if (classObject.mandatoryProperties.indexOf(p) === -1 &&
                ! classObject.optionalProperties.some(propertyExistsPredicate(p))) {
            throw new InvalidRoboHydraHeadException("Unknown property '" + p + "'");
        }
    }
};
RoboHydraHead.prototype.attached = function() {
    return this._attached;
};
RoboHydraHead.prototype.attach = function() {
    if (this._attached) {
        throw new InvalidRoboHydraHeadStateException(this._attached);
    }
    this._attached = true;
};
RoboHydraHead.prototype.detach = function() {
    if (! this._attached) {
        throw new InvalidRoboHydraHeadStateException(this._attached);
    }
    this._attached = false;
};
RoboHydraHead.prototype.normalizePath = function(path) {
    var normalizedPath = path[0] === '/' ? path : '/' + path;
    return normalizedPath.length > 1 ?
        normalizedPath.replace(new RegExp('/$'), '') :
        normalizedPath;
};
RoboHydraHead.prototype.stripGetParams = function(urlPath) {
    return urlPath.replace(new RegExp('\\?.*'), '');
};
RoboHydraHead.prototype.canHandle = function(req) {
    var reqPath = this.normalizePath(this.stripGetParams(req.url)),
        reqHostname = req.headers.host || "";
    return (this._attached &&
            this._matchesUrlPath(reqPath) &&
            this._matchesHostname(reqHostname) &&
            this._methods.some(function(m) {
                return m === '*' || m === req.method;
            }));
};
RoboHydraHead.prototype._matchesHostname = function(hostname) {
    var bareHostname = hostname.split(":")[0];
    return bareHostname.match(new RegExp("^" + this.hostname + "$"));
};
RoboHydraHead.prototype._matchesUrlPath = function(path) {
    return path.match(new RegExp("^" + this.path + "$"));
};
RoboHydraHead.prototype.handle = function(req, res, next) {
    if (this.canHandle(req)) {
        try {
            this._handle(req, res, next);
        } catch (e) {
            // If the end callback function throws an exception, just
            // throw that exception, don't pollute the response body
            // with more data or re-fire the end function.
            if (res.ended) {
                throw e;
            } else {
                res.statusCode = 500;
                res.send(e.stack);
            }
        }
    } else {
        res.statusCode = 404;
        res.send("Not Found");
    }
};
RoboHydraHead.prototype._handle = function(req, res, next) {
    // Convert path to a regular expression, and collect the
    // captured names so we can assign the appropriate values to
    // req.param.<name>
    var nakedUrl = this.stripGetParams(req.url);
    var finalReq = req;
    if (this.requestParamNames.length > 0) {
        finalReq = extendObject({}, req);
        var matches = nakedUrl.match(this.path);
        if (matches) {
            finalReq.params = {};
            // Save captured names in req.param.<name>
            for (var i = 0, len = this.requestParamNames.length; i < len; i++) {
                finalReq.params[this.requestParamNames[i]] = decodeURIComponent(matches[i + 1]);
            }
        }
    }

    this.handler(finalReq, res, next);
};



function RoboHydraWebSocketHead(props) {
    // If you don't pass props at all, created a "generic", valid
    // RoboHydra head. This is useful for inheritance and for when you
    // don't really care about the behaviour of the head (you just
    // want one created)
    props = props || {path: '/.*', handler: function(_, res) {res.end();}};

    this.type = 'generic';
    this.importProperties(RoboHydraWebSocketHead, props);

    var self = this;
    this._attached = !props.detached;
    this.requestParamNames = [];
    this.path = this.normalizePath(props.path || '/.*').
        replace(/:(\w+)/g,
                function(_, name) {
                    self.requestParamNames.push(name);
                    return '([^/]+)';
                });
    if (typeof this.reset !== 'function') {
        throw new InvalidRoboHydraHeadException("Property 'reset' must be a function");
    }
    this.reset();
}
RoboHydraWebSocketHead.mandatoryProperties = ['path', 'handler'];
RoboHydraWebSocketHead.optionalProperties = [].concat(IMPLICIT_OPTIONAL_PROPS);
RoboHydraWebSocketHead.prototype.importProperties = function(classObject, props) {
    function propertyExistsPredicate(p) {
        return function(propDef) {
            if (typeof propDef === 'object') {
                return propDef.name === p;
            } else {
                return propDef === p;
            }
        };
    }

    var self = this;

    // Mandatory properties
    classObject.mandatoryProperties.forEach(function(p) {
        if (props[p] === undefined) {
            throw new InvalidRoboHydraHeadException("Missing mandatory property '" + p + "'");
        }
        self[p] = props[p];
    });

    // Optional properties
    classObject.optionalProperties.forEach(function(p) {
        var propName         = (typeof p === 'object') ? p.name : p,
            propDefaultValue = (typeof p === 'object') ? p.defaultValue :
                undefined;
        self[propName] = (props[propName] !== undefined) ?
            props[propName] :
            propDefaultValue;
    });

    // Check that there aren't any extra properties
    for (var p in props) {
        if (classObject.mandatoryProperties.indexOf(p) === -1 &&
            ! classObject.optionalProperties.some(propertyExistsPredicate(p))) {
            throw new InvalidRoboHydraHeadException("Unknown property '" + p + "'");
        }
    }
};
RoboHydraWebSocketHead.prototype.attached = function() {
    return this._attached;
};
RoboHydraWebSocketHead.prototype.attach = function() {
    if (this._attached) {
        throw new InvalidRoboHydraHeadStateException(this._attached);
    }
    this._attached = true;
};
RoboHydraWebSocketHead.prototype.detach = function() {
    if (! this._attached) {
        throw new InvalidRoboHydraHeadStateException(this._attached);
    }
    this._attached = false;
};
RoboHydraWebSocketHead.prototype.normalizePath = function(path) {
    var normalizedPath = path[0] === '/' ? path : '/' + path;
    return normalizedPath.length > 1 ?
        normalizedPath.replace(new RegExp('/$'), '') :
        normalizedPath;
};
RoboHydraWebSocketHead.prototype.stripGetParams = function(urlPath) {
    return urlPath.replace(new RegExp('\\?.*'), '');
};
RoboHydraWebSocketHead.prototype.canHandle = function(req) {
    var reqPath = this.normalizePath(this.stripGetParams(req.url)),
        reqHostname = req.headers.host || "";
    return (this._attached &&
            this._matchesUrlPath(reqPath) &&
            this._matchesHostname(reqHostname));
};
RoboHydraWebSocketHead.prototype._matchesHostname = function(hostname) {
    var bareHostname = hostname.split(":")[0];
    return bareHostname.match(new RegExp("^" + this.hostname + "$"));
};
RoboHydraWebSocketHead.prototype._matchesUrlPath = function(path) {
    return path.match(new RegExp("^" + this.path + "$"));
};
RoboHydraWebSocketHead.prototype.handle = function(req, socket) {
    if (this.canHandle(req)) {
        try {
            this._handle(req, socket);
        } catch (e) {
            // TODO: See if there's something better to do
            socket.close();
        }
    } else {
        // TODO: See if there's something better to do
        socket.close();
    }
};
RoboHydraWebSocketHead.prototype._handle = function(req, socket) {
    // Convert path to a regular expression, and collect the
    // captured names so we can assign the appropriate values to
    // req.param.<name>
    var nakedUrl = this.stripGetParams(req.url);
    var finalReq = req;
    if (this.requestParamNames.length > 0) {
        finalReq = extendObject({}, req);
        var matches = nakedUrl.match(this.path);
        if (matches) {
            finalReq.params = {};
            // Save captured names in req.param.<name>
            for (var i = 0, len = this.requestParamNames.length; i < len; i++) {
                finalReq.params[this.requestParamNames[i]] = decodeURIComponent(matches[i + 1]);
            }
        }
    }

    this.handler(finalReq, socket);
};



// Convenience function to create new types of heads. It takes care of
// a bit of inheritance hassle.
function robohydraHeadType(settings) {
    var parentClass = settings.parentClass || RoboHydraHead;

    var newConstructorFunction = function(props) {
        if (!props && settings.defaultProps) {
            deprecationWarning("deprecated 'defaultProps', please use 'defaultPropertyObject' instead");
            props = settings.defaultProps;
        }
        props = props || settings.defaultPropertyObject || {};

        // Checks mandatory and optional properties
        this.importProperties(newConstructorFunction, props);

        var parentPropBuilder =
                settings.parentPropertyBuilder || function() { return {}; };
        if (settings.parentPropBuilder) {
            deprecationWarning("deprecated 'parentPropBuilder', please use 'parentPropertyBuilder' instead");
            parentPropBuilder = settings.parentPropBuilder;
        }
        var parentProps = parentPropBuilder.call(this);
        IMPLICIT_OPTIONAL_PROPS.forEach(function(p) {
            var propName = typeof p === 'object' ? p.name : p;
            if (! (propName in parentProps)) {
                parentProps[propName] = this[propName];
            }
        }, this);
        parentClass.call(this, parentProps);

        this.type = settings.name || '<undefined>';
        if (typeof settings.init === 'function') {
            settings.init.call(this);
        }
    };

    newConstructorFunction.mandatoryProperties =
        settings.mandatoryProperties || [];
    newConstructorFunction.optionalProperties =
        (settings.optionalProperties || []).concat(IMPLICIT_OPTIONAL_PROPS);
    newConstructorFunction.prototype = new parentClass();

    return newConstructorFunction;
}
function roboHydraHeadType(settings) {
    deprecationWarning("deprecated 'roboHydraHeadType', please use 'robohydraHeadType' instead");
    return robohydraHeadType(settings);
}


function _nextIndex(currentIndex, numberResponses, repeatMode) {
    return repeatMode === 'round-robin' ?
        (currentIndex + 1) % numberResponses :
        Math.min(currentIndex + 1, numberResponses - 1);
}

var responseProperties = ['content', 'contentType', 'statusCode', 'headers'];
var RoboHydraHeadStatic = robohydraHeadType({
    name: 'static',
    defaultPropertyObject: {content: ''},

    optionalProperties: [{name: 'path', defaultValue: '/.*'},
                         'responses',
                         {name: 'repeatMode', defaultValue: 'round-robin'}].
        concat(responseProperties),

    init: function() {
        if (this.content === undefined && this.responses === undefined) {
            throw new InvalidRoboHydraHeadException("RoboHydraHeadStatic needs either 'content' or 'responses'");
        }
        if (this.responses !== undefined) {
            if (this.responses.length === 0) {
                throw new InvalidRoboHydraHeadException("RoboHydraHeadStatic 'responses', if given, must be a non-empty array");
            }

            this.responses.forEach(function(resp) {
                for (var p in resp) {
                    if (resp.hasOwnProperty(p) &&
                            responseProperties.indexOf(p) === -1) {
                        throw new InvalidRoboHydraHeadException("Unknown property '" + p + "' in RoboHydraHeadStatic 'responses' array item. They must only have " + responseProperties.join(" and/or "));
                    }
                }
            });
        }
        if (['round-robin', 'repeat-last'].indexOf(this.repeatMode) === -1) {
            throw new InvalidRoboHydraHeadException("Unknown value '" + this.repeatMode + "' for 'repeatMode' property");
        }
    },

    parentPropertyBuilder: function() {
        return {path:    this.path,
                reset: function() {
                    this.responseIndex = 0;
                },
                handler: function(req, res) {
                    var content     = this.content,
                        headers     = this.headers,
                        contentType = this.contentType,
                        statusCode  = this.statusCode;
                    if (this.responses !== undefined) {
                        var currentResponse = this.responses[this.responseIndex];
                        content     = currentResponse.content     || content;
                        contentType = currentResponse.contentType || contentType;
                        statusCode  = currentResponse.statusCode  || statusCode;
                        this.responseIndex =
                            _nextIndex(this.responseIndex,
                                       this.responses.length,
                                       this.repeatMode);
                    }
                    if (typeof(content) !== 'string') {
                        content = JSON.stringify(content);
                        contentType = contentType || 'application/json';
                    }
                    if (headers) {
                        for (var h in headers) {
                            res.headers[h.toLowerCase()] = headers[h];
                        }
                    }
                    if (contentType) {
                        res.headers["content-type"] = contentType;
                    }
                    if (statusCode) {
                        res.statusCode = statusCode;
                    }
                    res.send(content);
                }};
    }
});


var RoboHydraHeadMounted = robohydraHeadType({
    name: 'generic-mounted',
    defaultPropertyObject: {mountPath: '/', handler: function(_, res) {res.end();}},

    mandatoryProperties: ['mountPath', 'handler'],

    init: function() {
        this.mountPath = this.normalizePath(this.mountPath);
    },

    parentPropertyBuilder: function() {
        return {
            path:    this.normalizePath(this.mountPath),
            handler: this.handler
        };
    }
});
RoboHydraHeadMounted.prototype._escapeRegExp = function(string) {
    return string.replace(/[\\\^\$*+\?.(){}\[\]|]/g, "\\$&");
};
RoboHydraHeadMounted.prototype._relativePath = function(url) {
    var pathRe = new RegExp("^" + this._escapeRegExp(this.mountPath));
    return this.mountPath === '/' ? url : url.replace(pathRe, '');
};
RoboHydraHeadMounted.prototype._matchesUrlPath = function(path) {
    var mountPath = this.mountPath;

    if (mountPath === '/') {
        return true;
    }
    var headPathRegExpEscaped = this._escapeRegExp(mountPath);
    if (! path.match(new RegExp("^" + headPathRegExpEscaped))) {
        return false;
    }
    return path.length === mountPath.length || path[mountPath.length] === '/';
};


var RoboHydraHeadFilesystem = robohydraHeadType({
    name: 'filesystem',
    parentClass: RoboHydraHeadMounted,
    defaultPropertyObject: {documentRoot: '/tmp'},

    mandatoryProperties: ['documentRoot'],
    optionalProperties: [{name: 'mountPath', defaultValue: '/'},
                         'indexFiles',
                         {name: 'fs', defaultValue: fs},
                         {name: 'mime', defaultValue: mime}],

    parentPropertyBuilder: function() {
        return {
            mountPath: this.mountPath,
            handler: function(req, res) {
                var relUrlPath = this._relativePath(req.url).split('?')[0];
                var relFilePath = decodeURIComponent(relUrlPath);
                var filePath = path.join(this.documentRoot, relFilePath);
                serveStaticFile(filePath, res, {
                    fs: this.fs,
                    mime: this.mime,
                    headers: req.headers,
                    indexFiles: this.indexFiles
                });
            }
        };
    }
});

var RoboHydraHeadProxy = robohydraHeadType({
    name: 'proxy',
    parentClass: RoboHydraHeadMounted,
    defaultPropertyObject: {proxyTo: 'http://example.com'},

    mandatoryProperties: ['proxyTo'],
    optionalProperties: [{name: 'mountPath', defaultValue: '/'},
                         {name: 'httpRequestFunction', defaultValue: http.request},
                         {name: 'httpsRequestFunction', defaultValue: https.request},
                         {name: 'setHostHeader', defaultValue: true}],

    parentPropertyBuilder: function() {
        return {
            mountPath: this.mountPath,
            handler: function(req, res) {
                var requestUrlExtra = this._relativePath(req.url);

                var proxyUrl = url.parse(this.proxyTo);
                // This is different from normalizePath because in
                // this case we want to remove the trailing slash even
                // for '/'
                proxyUrl.pathname = proxyUrl.pathname.replace(new RegExp('/$'), '') +
                    requestUrlExtra;
                proxyRequest(req, res, proxyUrl,
                             {httpRequestFunction:  this.httpRequestFunction,
                              httpsRequestFunction: this.httpsRequestFunction,
                              setHostHeader:        this.setHostHeader});
            }
        };
    }
});

var RoboHydraHeadFilter = robohydraHeadType({
    name: 'filter',
    defaultPropertyObject: {filter: function(body) { return body; }},

    mandatoryProperties: ['filter'],
    optionalProperties: [{name: 'path', defaultValue: '/.*'}],

    init: function() {
        if (typeof this.filter !== 'function') {
            throw new InvalidRoboHydraHeadException("Property 'filter' must be a function");
        }
    },

    parentPropertyBuilder: function() {
        return {
            path:    this.path,
            handler: function(req, res, next) {
                var self = this;
                var fakeRes = new Response(function() {
                    self._compressionAwareFilter(
                        fakeRes.headers['content-encoding'],
                        fakeRes.body,
                        self.filter.bind(self),
                        function(err, data) {
                            fakeRes.body = data;
                            res.copyFrom(fakeRes);
                            if (res.headers['content-length'] !== undefined) {
                                res.headers['content-length'] = res.body.length;
                            }
                            res.end();
                        }
                    );
                });
                next(req, fakeRes);
            }
        };
    }
});
RoboHydraHeadFilter.prototype._compressionAwareFilter =
    function(compressionMethod, data, filter, cb) {
        var compress, uncompress;

        switch (compressionMethod) {
        case 'gzip':
            compress   = zlib.gzip;
            uncompress = zlib.gunzip;
            break;

        case 'deflate':
            compress   = zlib.deflate;
            uncompress = zlib.inflate;
            break;

        default:
            // If unknown (or no) compression method, pass-through
            compress = uncompress =
                function(data, cb) { cb(undefined,
                                        typeof data === 'string' ?
                                            new Buffer(data) : data); };
            break;
        }

        // What happens with corrupt compressed data? Node 0.6.x's zlib
        // doesn't seem to give proper error messages when the data is
        // corrupt
        uncompress(data, function(err, plainData) {
            if (err) {
                cb(err);
            } else {
                var filteredData = filter(plainData);
                if (filteredData === undefined) {
                    throw new InvalidRoboHydraHeadException("The filter function must never return undefined");
                }
                compress(filteredData, function(err, compressedData) {
                    cb(err, compressedData);
                });
            }
        });
    };


var RoboHydraHeadWatchdog = robohydraHeadType({
    name: 'watchdog',
    defaultPropertyObject: {watcher: function() { return false; }},

    mandatoryProperties: ['watcher'],
    optionalProperties: [
        {name: 'path', defaultValue: '/.*'},
        {name: 'reporter',
         defaultValue: function(req/*, res*/) {
             console.warn("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
             console.warn("Watchdog found request " + req.url);
             console.warn("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
         }}
    ],

    init: function() {
        if (typeof this.watcher !== 'function') {
            throw new InvalidRoboHydraHeadException("Property 'watcher' must be a function");
        }
        if (this.reporter !== undefined && typeof this.reporter !== 'function') {
            throw new InvalidRoboHydraHeadException("Property 'reporter' must be a function");
        }
    },

    parentPropertyBuilder: function() {
        return {
            path: this.path,
            handler: function(req, res, next) {
                var head = this;
                var fakeRes = new Response().on('end', function(evt) {
                    var response = evt.response;
                    head._uncompress(
                        response.headers['content-encoding'],
                        response.body,
                        function(err, data) {
                            if (err) {
                                console.warn("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
                                console.warn("WARNING: Error uncompressing response body");
                                console.warn("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
                            }

                            var newRes = new Response();
                            newRes.copyFrom(response);
                            newRes.rawBody = newRes.body;
                            // This will be undefined (or whatever) if it couldn't
                            // be uncompressed, but the rawBody will always be
                            // available, so it's probably fine?
                            newRes.body = data;

                            if (head.watcher(req, newRes)) {
                                head.reporter(req, newRes);
                            }

                            res.forward(response);
                        }
                    );
                });
                next(req, fakeRes);
            }
        };
    }
});
RoboHydraHeadWatchdog.prototype._uncompress =
    function(compressionMethod, data, cb) {
        var uncompress;

        switch (compressionMethod) {
        case 'gzip':
            uncompress = zlib.gunzip; break;
        case 'deflate':
            uncompress = zlib.inflate; break;
        default:
            // If unknown (or no) compression method, pass-through
            uncompress = function(data, cb) { cb(undefined, data); };
        }

        // What happens with corrupt compressed data? Node 0.6.x's zlib
        // doesn't seem to give proper error messages when the data is
        // corrupt
        uncompress(data, cb);
    };



exports.InvalidRoboHydraHeadException = InvalidRoboHydraHeadException;
exports.robohydraHeadType = robohydraHeadType;
exports.roboHydraHeadType = roboHydraHeadType;
exports.RoboHydraHead = RoboHydraHead;
exports.RoboHydraHeadStatic = RoboHydraHeadStatic;
exports.RoboHydraHeadFilesystem = RoboHydraHeadFilesystem;
exports.RoboHydraHeadProxy = RoboHydraHeadProxy;
exports.RoboHydraHeadFilter = RoboHydraHeadFilter;
exports.RoboHydraHeadWatchdog = RoboHydraHeadWatchdog;
exports.RoboHydraWebSocketHead = RoboHydraWebSocketHead;
