'use strict';

const generateMapping = require('./mapping').generate;
const client = require('./client');
const utils = require('./utils');
const Bulker = require('./bulker');
const mongoose = require('mongoose');

module.exports = function(schema, options, version) {
  // clone main level of options (does not clone deeper)
  options = utils.highClone(options);

  /**
   * Retrieve model options to ElasticSearch
   * static function
   * returns {Object}
   */
  function esOptions() {
    if (!options.index) {
      options.index = this.collection.name;
    }
    if (!options.type) {
      options.type = utils.lcFirst(
        this.modelName || this.constructor.modelName
      );
    }

    if (!options.index || !options.type) {
      throw new Error(
        options.index
          ? 'Missing model name to build ES type'
          : 'Missing collection name to build ES index'
      );
    }

    if (!options.client) {
      options.client = client(options);
    }

    if (options.bulk) {
      options.bulker = new Bulker(options.client, options.bulk);
    }

    if (!options.mapping) {
      options.mapping = Object.freeze({
        properties: generateMapping(this.schema, version),
      });
    }

    return utils.highClone(options);
  }

  schema.statics.esOptions = esOptions;
  schema.statics.esCreateMapping = createMapping;
  schema.statics.esRefresh = refresh;
  schema.statics.esSearch = search;
  schema.statics.esSynchronize = synchronize;
  schema.statics.esCount = count;

  schema.methods.esOptions = esOptions;
  schema.methods.esIndex = indexDoc;
  schema.methods.esUnset = unsetFields;
  schema.methods.esRemove = removeDoc;

  schema.pre('save', preSave);
  schema.post('save', postSave);
  schema.post('findOneAndUpdate', postSave);

  schema.post('remove', postRemove);
  schema.post('findOneAndRemove', postRemove);
};

module.exports.v2 = function(schema, options) {
  return module.exports(schema, options, 2);
};

/**
 * Map the model on ElasticSearch
 * static function
 * @param {Object} [settings]
 * @param {Function} [callback]
 * @returns {Promise|undefined}
 */
function createMapping(settings, callback) {
  if (typeof settings === 'function') {
    callback = settings;
    settings = null;
  }
  const self = this;
  return utils.run(callback, (resolve, reject) => {
    const esOptions = self.esOptions();

    settings = settings || esOptions.mappingSettings || {};

    const mapping = {};
    mapping[esOptions.type] = esOptions.mapping;

    esOptions.client.indices.exists({ index: esOptions.index }, (
      err,
      exists
    ) => {
      if (err) {
        return reject(err);
      }
      if (exists) {
        return esOptions.client.indices.putMapping(
          {
            index: esOptions.index,
            type: esOptions.type,
            body: mapping,
          },
          (err, result) => err ? reject(err) : resolve(result)
        );
      }
      return esOptions.client.indices.create(
        {
          index: esOptions.index,
          body: settings,
        },
        err => {
          if (err) {
            reject(err);
            return;
          }
          esOptions.client.indices.putMapping(
            {
              index: esOptions.index,
              type: esOptions.type,
              body: mapping,
            },
            (err, result) => err ? reject(err) : resolve(result)
          );
        }
      );
    });
  });
}

/**
 * Explicitly refresh the model index on ElasticSearch
 * static function
 * @param {Object} [options]
 * @param {Function} [callback]
 * @returns {Promise|undefined}
 */
function refresh(options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  const self = this;
  return utils.run(callback, (resolve, reject) => {
    const esOptions = self.esOptions();
    const refreshDelay = options.refreshDelay === false
      ? 0
      : options.refreshDelay || esOptions.refreshDelay;
    esOptions.client.indices.refresh(
      {
        index: esOptions.index,
      },
      (err, result) => {
        setTimeout(() => err ? reject(err) : resolve(result), refreshDelay);
      }
    );
  });
}

/**
 * Perform a count query on ElasticSearch
 * static function
 * @param {Object|string} query
 * @param {Object} [options]
 * @param {Function} [callback]
 * @returns {Promise|undefined}
 */
function count(query, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  query = query || {};
  options = options || {};
  const self = this;
  return utils.run(callback, (resolve, reject) => {
    const esOptions = self.esOptions();
    const countOnly = options.countOnly === false
      ? false
      : options.countOnly || esOptions.countOnly;
    const params = {
      index: esOptions.index,
      type: esOptions.type,
    };
    if (typeof query === 'string') {
      params.q = query;
    } else {
      params.body = query.query ? query : { query };
    }
    esOptions.client.count(params, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(countOnly ? result.count : result);
      }
    });
  });
}

/**
 * Perform a search query on ElasticSearch
 * static function
 * @param {Object|string} query
 * @param {Object} [options]
 * @param {Function} [callback]
 * @returns {Promise|undefined}
 */
function search(query, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  query = query || {};
  options = options || {};
  const self = this;
  return utils.run(callback, (resolve, reject) => {
    const esOptions = self.esOptions();
    const hydrate = options.hydrate === false
      ? false
      : options.hydrate || esOptions.hydrate;
    const idsOnly = options.idsOnly === false
      ? false
      : options.idsOnly || esOptions.idsOnly;

    const params = {
      index: esOptions.index,
      type: esOptions.type,
    };

    if (typeof query === 'string') {
      params.q = query;
    } else {
      params.body = query.query ? query : { query };
    }
    if (hydrate) {
      params._source = false;
    }
    esOptions.client.search(params, (err, result) => {
      if (err) {
        reject(err);
        return;
      }

      if (!hydrate && !idsOnly) {
        resolve(result);
        return;
      }

      const ids = result.hits.hits.map(hit => mongoose.Types.ObjectId(hit._id));

      if (idsOnly) {
        resolve(ids);
        return;
      }

      const select = hydrate.select || null;
      const opts = hydrate.options || null;
      const docsOnly = hydrate.docsOnly || false;

      if (!result.hits.total) {
        resolve(docsOnly ? [] : result);
        return;
      }

      self.find({ _id: { $in: ids } }, select, opts, (err, users) => {
        if (err) {
          return reject(err);
        }
        const userByIds = {};
        users.forEach(user => {
          userByIds[user._id] = user;
        });
        if (docsOnly) {
          result = ids.map(id => userByIds[id]);
        } else {
          result.hits.hits.forEach(hit => {
            hit.doc = userByIds[hit._id];
          });
        }
        return resolve(result);
      });
    });
  });
}

/**
 * Synchronize the collection with ElasticSearch
 * static function
 * @param {Object} [conditions]
 * @param {String} [projection]
 * @param {Object} [options]
 * @param {Function} [callback]
 * @returns {Promise|undefined}
 */
function synchronize(conditions, projection, options, callback) {
  if (typeof conditions === 'function') {
    callback = conditions;
    conditions = {};
    projection = null;
    options = null;
  } else if (typeof projection === 'function') {
    callback = projection;
    projection = null;
    options = null;
  } else if (typeof options === 'function') {
    callback = options;
    options = null;
  }
  const model = this;
  return utils.run(callback, (resolve, reject) => {
    const esOptions = model.esOptions();
    const batch = esOptions.bulk && esOptions.bulk.batch
      ? esOptions.bulk.batch
      : 50;
    const stream = model
      .find(conditions || {}, projection, options)
      .batchSize(batch)
      .stream();
    const bulker = esOptions.bulker || new Bulker(esOptions.client);
    let streamClosed = false;

    function finalize() {
      bulker.removeListener('error', onError);
      bulker.removeListener('sent', onSent);
      esOptions.client.indices.refresh(
        { index: esOptions.index },
        (err, result) => err ? reject(err) : resolve(result)
      );
    }

    function onError(err) {
      model.emit('es-bulk-error', err);
      if (streamClosed) {
        finalize();
      } else {
        stream.resume();
      }
    }

    function onSent(len) {
      model.emit('es-bulk-sent', len);
      if (streamClosed) {
        finalize();
      } else {
        stream.resume();
      }
    }

    bulker.on('error', onError);
    bulker.on('sent', onSent);

    stream.on('data', doc => {
      stream.pause();
      let sending;
      if (!esOptions.filter || esOptions.filter(doc)) {
        sending = bulker.push(
          {
            index: {
              _index: esOptions.index,
              _type: esOptions.type,
              _id: doc._id.toString(),
            },
          },
          utils.serialize(doc, esOptions.mapping)
        );
        model.emit('es-bulk-data', doc);
      } else {
        model.emit('es-bulk-filtered', doc);
      }
      if (!sending) {
        stream.resume();
      }
    });

    stream.on('close', () => {
      streamClosed = true;
      if (bulker.filled()) {
        bulker.flush();
      } else {
        finalize();
      }
    });
  });
}

/**
 * Index the current document on ElasticSearch
 * document function
 * @param {Boolean|Object} [update] default false
 * @param {Function} [callback]
 * @returns {Promise|undefined}
 */
function indexDoc(update, callback) {
  const self = this;
  if (typeof update === 'function') {
    callback = update;
    update = false;
  }
  return utils.run(callback, (resolve, reject) => {
    const esOptions = self.esOptions();
    const body = utils.serialize(self, esOptions.mapping);
    if (update && update.unset) {
      (typeof update.unset === 'string'
        ? [update.unset]
        : update.unset).forEach(field => {
        body[field] = null;
      });
    }
    _indexDoc(self._id, body, esOptions, resolve, reject, update);
  });
}

/**
 * Update or Index a document, when updating, retry as index when getting a 404 error
 * @param {ObjectId|String} id
 * @param {Object} body
 * @param {Object} esOptions
 * @param {Function} resolve
 * @param {Function} reject
 * @param {Boolean} [update] default false
 * @private
 */
function _indexDoc(id, body, esOptions, resolve, reject, update) {
  esOptions.client[update ? 'update' : 'index'](
    {
      index: esOptions.index,
      type: esOptions.type,
      id: id.toString(),
      body: update ? { doc: body } : body,
    },
    (err, result) => {
      if (update && err && err.status === 404) {
        _indexDoc(id, body, esOptions, resolve, reject);
      } else if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    }
  );
}

/**
 * Unset some fields from the current document
 * @param {String|Array} fields to unset
 * @param {Function} [callback]
 * @returns {Promise|undefined}
 */
function unsetFields(fields, callback) {
  const self = this;
  return utils.run(callback, (resolve, reject) => {
    const esOptions = self.esOptions();
    let body;

    if (typeof fields === 'string') {
      fields = [fields];
    }

    if (esOptions.script) {
      body = {
        script: fields.map(field => `ctx._source.remove("${field}")`).join(';'),
      };
    } else {
      body = { doc: {} };
      fields.forEach(field => {
        body.doc[field] = null;
      });
    }

    esOptions.client.update(
      {
        index: esOptions.index,
        type: esOptions.type,
        id: self._id.toString(),
        body,
      },
      (err, result) => err ? reject(err) : resolve(result)
    );
  });
}

/**
 * Remove the current document from ElasticSearch
 * document function
 * @param {Function} [callback]
 * @returns {Promise|undefined}
 */
function removeDoc(callback) {
  const self = this;
  return utils.run(callback, (resolve, reject) => {
    const esOptions = self.esOptions();
    esOptions.client.delete(
      {
        index: esOptions.index,
        type: esOptions.type,
        id: self._id.toString(),
      },
      err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

/**
 * Pre save document handler
 * internal
 * @param {Function} next
 */
function preSave(next) {
  this._mexp = {
    wasNew: this.isNew,
  };
  if (!this.isNew) {
    this._mexp.unset = utils.getUndefineds(this, this.esOptions().mapping);
  }
  next();
}

/**
 * Post save document handler
 * internal
 * @param {Object} doc
 */
function postSave(doc) {
  if (doc && doc.esOptions) {
    const data = doc._mexp || {};
    const esOptions = doc.esOptions();
    delete doc._mexp;
    if (!esOptions.filter || esOptions.filter(doc)) {
      doc
        .esIndex(data.wasNew ? false : { unset: data.unset })
        .then(res => {
          if (esOptions.script && data.unset && data.unset.length) {
            return doc.esUnset(data.unset);
          }
          return res;
        })
        .then(res => {
          doc.emit('es-indexed', undefined, res);
          doc.constructor.emit('es-indexed', undefined, res);
        })
        .catch(err => {
          doc.emit('es-indexed', err);
          doc.constructor.emit('es-indexed', err);
        });
    } else {
      doc.emit('es-filtered');
      doc.constructor.emit('es-filtered');
      if (!data.wasNew) {
        doc.esRemove((err, res) => {
          doc.emit('es-removed', err, res);
          doc.constructor.emit('es-removed', err, res);
        });
      }
    }
  }
}

/**
 * Post remove document handler
 * internal
 * @param {Object} doc
 */
function postRemove(doc) {
  if (doc && doc.esOptions) {
    doc.esRemove((err, res) => {
      doc.emit('es-removed', err, res);
      doc.constructor.emit('es-removed', err, res);
    });
  }
}