'use strict';

var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var Promise = require('rsvp').Promise;
var Plugin = require('broccoli-plugin');
var helpers = require('broccoli-kitchen-sink-helpers');
var walkSync = require('walk-sync');
var mapSeries = require('promise-map-series');
var symlinkOrCopySync = require('symlink-or-copy').sync;
var copyDereferenceSync = require('copy-dereference').sync;
var Cache = require('./lib/cache');
var debugGenerator = require('debug');
var keyForFile = require('./lib/key-for-file');

module.exports = Filter;

Filter.prototype = Object.create(Plugin.prototype);
Filter.prototype.constructor = Filter;
function Filter(inputTree, options) {
  if (!this || !(this instanceof Filter) ||
      Object.getPrototypeOf(this) === Filter.prototype) {
    throw new TypeError('Filter is an abstract class and must be sub-classed');
  }

  var name = 'broccoli-filter:' + (this.constructor.name);
  if (this.description) {
    name += ' > [' + this.description + ']';
  }

  this._debug = debugGenerator(name);

  Plugin.call(this, [inputTree]);

  /* Destructuring assignment in node 0.12.2 would be really handy for this! */
  if (options) {
    if (options.extensions != null)
      this.extensions = options.extensions;
    if (options.targetExtension != null)
      this.targetExtension = options.targetExtension;
    if (options.inputEncoding != null)
      this.inputEncoding = options.inputEncoding;
    if (options.outputEncoding != null)
      this.outputEncoding = options.outputEncoding;
  }

  this._cache = new Cache();
  this._canProcessCache = Object.create(null);
  this._destFilePathCache = Object.create(null);
}

Filter.prototype.build = function build() {
  var self = this;
  var srcDir = this.inputPaths[0];
  var destDir = this.outputPath;
  var paths = walkSync(srcDir);

  this._cache.deleteExcept(paths).forEach(function(key) {
    fs.unlinkSync(this.cachePath + '/' + key);
  }, this);

  return mapSeries(paths, function rebuildEntry(relativePath) {
    var destPath = destDir + '/' + relativePath;
    if (relativePath.slice(-1) === '/') {
      mkdirp.sync(destPath);
    } else {
      if (self.canProcessFile(relativePath)) {
        return self.processAndCacheFile(srcDir, destDir, relativePath);
      } else {
        var srcPath = srcDir + '/' + relativePath;
        symlinkOrCopySync(srcPath, destPath);
      }
    }
  });
};

Filter.prototype.canProcessFile =
    function canProcessFile(relativePath) {
  return !!this.getDestFilePath(relativePath);
};

Filter.prototype.getDestFilePath = function getDestFilePath(relativePath) {
  if (this.extensions == null) return relativePath;

  for (var i = 0, ii = this.extensions.length; i < ii; ++i) {
    var ext = this.extensions[i];
    if (relativePath.slice(-ext.length - 1) === '.' + ext) {
      if (this.targetExtension != null) {
        relativePath =
            relativePath.slice(0, -ext.length) + this.targetExtension;
      }
      return relativePath;
    }
  }
  return null;
}

Filter.prototype.processAndCacheFile =
    function processAndCacheFile(srcDir, destDir, relativePath) {
  var self = this;
  var cacheEntry = this._cache.get(relativePath);
  var outputRelativeFile = self.getDestFilePath(relativePath);

  if (cacheEntry) {
    var hashResult = hash(srcDir, cacheEntry.inputFile);

    if (cacheEntry.hash.hash === hashResult.hash) {
      this._debug('cache hit: %s', relativePath);

      return symlinkOrCopyFromCache(cacheEntry);
    } else {
      this._debug('cache miss: %s \n  - previous: %o \n  - next:     %o ', relativePath, cacheEntry.hash.key, hashResult.key);
    }

  } else {
    this._debug('cache prime: %s', relativePath);
  }

  cacheEntry = {
    hash: hash(srcDir, relativePath),
    inputFile: relativePath,
    results: [
      {
        output: destDir + '/' + outputRelativeFile,
        cache: self.cachePath + '/' + outputRelativeFile
      }
    ]
  };

  function addOutputFile(contents, outputRelativeFilename) {
    var outputPath = path.join(destDir, outputRelativeFilename);
    fs.writeFileSync(outputPath, contents, { encoding: self.outputEncoding });
    cacheEntry.results.push({
      output: destDir + '/' + outputRelativeFilename,
      cache: self.cachePath + '/' + outputRelativeFilename
    });
  }

  return Promise.resolve().
      then(function asyncProcessFile() {
        return self.processFile(srcDir, destDir, relativePath, addOutputFile);
      }).
      then(copyToCache,
      // TODO(@caitp): error wrapper is for API compat, but is not particularly
      // useful.
      // istanbul ignore next
      function asyncProcessFileErrorWrapper(e) {
        if (typeof e !== 'object' || e === null) e = new Error('' + e);
        e.file = relativePath;
        e.treeDir = srcDir;
        throw e;
      })

  function copyToCache() {
    cacheEntry.results.forEach(function(result) {
      if (fs.existsSync(result.cache)) {
        fs.unlinkSync(result.cache);
      } else {
        mkdirp.sync(path.dirname(result.cache));
      }

      copyDereferenceSync(result.output, result.cache);
    });

    return self._cache.set(relativePath, cacheEntry);
  }
};

Filter.prototype.processFile =
    function processFile(srcDir, destDir, relativePath, addOutputFile) {
  var self = this;
  var inputEncoding = this.inputEncoding;
  var outputEncoding = this.outputEncoding;
  if (inputEncoding === void 0) inputEncoding = 'utf8';
  if (outputEncoding === void 0) outputEncoding = 'utf8';
  var contents = fs.readFileSync(
      srcDir + '/' + relativePath, { encoding: inputEncoding });

  return Promise.resolve(this.processString(contents, relativePath, addOutputFile)).
      then(function asyncOutputFilteredFile(outputString) {
        var outputPath = self.getDestFilePath(relativePath);
        if (outputPath == null) {
          throw new Error('canProcessFile("' + relativePath + '") is true, but getDestFilePath("' + relativePath + '") is null');
        }
        outputPath = destDir + '/' + outputPath;
        mkdirp.sync(path.dirname(outputPath));
        fs.writeFileSync(outputPath, outputString, {
          encoding: outputEncoding
        });
      });
};

Filter.prototype.processString =
    function unimplementedProcessString(contents, relativePath, addOutputFile) {
  throw new Error(
      'When subclassing broccoli-filter you must implement the ' +
      '`processString()` method.');
};

function hash(src, filePath) {
  var path = src + '/' + filePath;
  var key = keyForFile(path);

  return {
    key: key,
    hash: helpers.hashStrings([
      path,
      key.size,
      key.mode,
      key.mtime
    ])
  };
}

function symlinkOrCopyFromCache(entry) {
  entry.results.forEach(function(result) {
    mkdirp.sync(path.dirname(result.output));

    symlinkOrCopySync(result.cache, result.output);
  });
}
