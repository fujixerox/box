var async = require('async');
var request = require('request');
var constants = require('./../lib/constants');
var elasticsearch = require('./../lib/elasticsearch');
var invoker = require('./../lib/invoker');

var TITLE = constants.TITLE;

function index(req, res) {
  if (req.isAuthenticated()) {
    res.redirect('/folders/0');
  } else {
    res.render('index', { title: TITLE });
  }
}

function folders(req, res) {
  invoker.folder(req.session.passport.user.accessToken, req.params.id, function(err, result) {
    if (err) {
      console.error(err);
      res.send(500);
    } else {
      result.item_collection.entries.forEach(function(entry) {
        entry.href = '/' + entry.type + 's/' + entry.id;
      });
      res.render('folders', { title: TITLE, result: result });
    }
  });
}

function files(req, res) {
  invoker.file(req.session.passport.user.accessToken, req.params.id, function(err, result) {
    if (err) {
      console.error(err);
      res.send(500);
    } else {
      res.render('files', { title: TITLE, result: result });
    }
  });
}

function download(req, res) {
  request.get({
    headers: { Authorization: "Bearer " + req.session.passport.user.accessToken },
    url: constants.CONTENT_API_BASE + '/files/' + req.params.id + '/content'
  }).pipe(res);
}

function view(req, res) {
  async.parallel({
    file: function (callback) {
      invoker.file(req.session.passport.user.accessToken, req.params.id, callback);
    },
    documents: function (callback) {
      invoker.documents(callback);
    }
  }, function (err, result) {
    if (err) {
      console.error(err);
      res.send(500);
      return;
    }
    if (result.documents.document_collection.entries.some(function(entry) {
      return entry.name === req.params.id && new Date(result.file.modified_at) < new Date(entry.created_at);
    })) {
      var id = result.documents.document_collection.entries.filter(function(entry) {
        return entry.name === req.params.id && new Date(result.file.modified_at) < new Date(entry.created_at);
      }).shift().id;
      invoker.sessions(id, function(err, result) {
        if (err) {
          console.error(err);
          res.send(500);
          return;
        }
        res.redirect(result.urls.view);
      });
    } else {
      async.waterfall([
        function (callback) {
          invoker.location(req.session.passport.user.accessToken, req.params.id, callback);
        },
        function (url, callback) {
          invoker.upload(url, req.params.id, callback);
        },
        function (body, callback) {
          invoker.sessions(body.id, callback);
        }
      ], function (err, result) {
        if (err) {
          console.error(err);
          res.send(500);
          return;
        }
        res.redirect(result.urls.view);
      });
    }
  });
}

function indexing(userId, token, id, callback) {
  async.waterfall([
    function(callback) {
      async.parallel({
        file: function (callback) {
          invoker.file(token, id, callback);
        },
        documents: function (callback) {
          invoker.documents(callback);
        }
      }, callback);
    },
    function(result, callback) {
      if (result.documents.document_collection.entries.some(function (entry) {
        return entry.name === id && new Date(result.file.modified_at) < new Date(entry.created_at);
      })) {
        callback(null, {
          file: result.file,
          id:   result.documents.document_collection.entries.filter(function (entry) {
            return entry.name === id && new Date(result.file.modified_at) < new Date(entry.created_at);
          }).shift().id
        });
      } else {
        async.waterfall([
          function (callback) {
            invoker.location(token, id, callback);
          },
          function (url, callback) {
            invoker.upload(url, id, callback);
          }
        ], function(err, id) {
          callback(err, { file: result.file, id: id });
        });
      }
    },
    function(result, callback) {
      elasticsearch.documents(result.file.id, userId, function(err, documents) {
        if (documents.length > 0) {
          var modified = new Date(result.file.modified_at);
          var isUpdated = documents.every(function (document) {
            return document._source.modified === result.file.modified_at || new Date(document._source.modified) === modified;
          });
          if (isUpdated) {
            callback();
            return;
          }
        }
        async.waterfall([
          function (callback) {
            invoker.extract(result.id, callback);
          },
          function (text, callback) {
            elasticsearch.upsertDocument(documents, result.file.id, result.file.name, result.file.modified_at, result.file.created_by.id, text, callback);
          }
        ], callback);
      });
    }
  ], callback);
}

function documents(req, res) {
  invoker.documents(function(err, result) {
    if (err) {
      console.error(err);
      res.send(500);
      return;
    }
    res.render('documents', { title: TITLE, result: result });
  });
}

function zip(req, res) {
  request.get({
    headers: { Authorization: "Token " + process.env.API_KEY },
    url: constants.VIEW_API_BASE + '/documents/' + req.params.id + '/content.zip'
  }).pipe(res);
}

function pdf(req, res) {
  request.get({
    headers: { Authorization: "Token " + process.env.API_KEY },
    url: constants.VIEW_API_BASE + '/documents/' + req.params.id + '/content.pdf'
  }).pipe(res);
}

function createIndex(req, res) {
  if (typeof req.params.id !== 'string') {
    res.send(400);
    return;
  }
  indexing(req.session.passport.user.id, req.session.passport.user.accessToken, req.params.id, function(err, result) {
    if (err) {
      res.send(500);
      console.error(err);
      return;
    }
    res.send(result);
  });
}

function search(req, res) {
  if (typeof req.query.query !== 'string' || req.query.query === '') {
    res.send(400);
    return;
  }
  elasticsearch.search(req.session.passport.user.id, req.query.query, function(err, result) {
    if (err) {
      res.send(500);
      console.error(err);
      return;
    }
    res.render('search', { title: TITLE, result: result, query: req.query.query });
  });
}

exports.index = index;
exports.folders = folders;
exports.files = files;
exports.download = download;
exports.view = view;
exports.documents = documents;
exports.zip = zip;
exports.pdf = pdf;
exports.createIndex = createIndex;
exports.search = search;
