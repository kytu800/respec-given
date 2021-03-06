var Stack = require('./stack'),
    BlockManager = require('./block-manager'),
    documentationify = require('./documentationify'),
    _ = require('lodash'),
    tosource = require('tosource')

var isGoodHabitModeEnabled = require('./good-habit-mode/is-enabled'),
    GoodHabitViolationError = require('./good-habit-mode/GoodHabitViolationError')

module.exports = {

  createBlockManager: function() {
    var blockStack = Object.create(Stack)
    blockStack._arr = []
    var blockManager = Object.create(BlockManager)
    blockManager._blockStack = blockStack
    return blockManager
  },

  createCore: function(opts) {
    var addSuiteCallback = opts.addSuiteCallback,
        addSkippedSuiteCallback = opts.addSkippedSuiteCallback,
        addTestCallback = opts.addTestCallback,
        blockManager = this.createBlockManager()

    blockManager.enter( opts.firstSuite )

    function describe(title, fn) {
      var suite = addSuiteCallback(blockManager.currentSuite(), title)
      blockManager.enter(suite)
      fn.call(suite) // `this` of describe/context (declaration time)
      blockManager.exit()
    }

    function it(title, fn) {
      addTestCallback(blockManager.currentSuite(), title, fn)
    }

    function xdescribe(title, fn) {
      var suite = addSkippedSuiteCallback(blockManager.currentSuite(), title)
      blockManager.enter(suite)
      fn.call(suite)
      blockManager.exit()
    }

    function createGivenLikeFunction(keyword) {
      return function GivenLike() {
        var assignTo = findFirstThatIsString(arguments)
        var fn = findFirstThatIsFunction(arguments)

        // Given(hash)
        if (_.isPlainObject(arguments[0])) {
          var hash = arguments[0]
          for (var key in hash)
            GivenLike(key, hash[key])
          return
        }

        if (typeof fn !== 'function') throw new Error(keyword + ': no function provided')

        // Given(fn)
        if (arguments.length === 1) {
          blockManager.addGivenToCurrent(fn)
          return
        }

        // Given(var, fn)
        blockManager.addGivenToCurrent(createLazyVar(assignTo, fn))
      }
    }

    function createLazyVar(varname, fn) {
      return function() {
        var cache = null
        var evaluated = false
        var ctx = this

        Object.defineProperty(ctx, varname, {
          configurable: true, // allow delete and redefine
          get: function() {
            if (!evaluated) {
              evaluated = true
              return cache = fn.call(ctx)
            }
            return cache
          },
          set: function(newVal) {
            cache = newVal
          }
        })
      }
    }

    function createWhenLikeFunction(keyword) {
      return function WhenLike() {
        var assignTo = findFirstThatIsString(arguments)
        var fn = findFirstThatIsFunction(arguments)

        // When(hash)
        if (_.isPlainObject(arguments[0])) {
          var hash = arguments[0]
          for (var key in hash)
            WhenLike(key, hash[key])
          return
        }

        if (typeof fn !== 'function') throw new Error(keyword + ': no function provided')

        // When(fn)
        if (arguments.length === 1) {
          blockManager.addWhenToCurrent(fn)
          return
        }

        // When(result, fn)
        // When(result, fn(done))
        blockManager.addWhenToCurrent(resolveActionToResult(fn, assignTo))
      }
    }

    function resolveActionToResult(fn, resultName) {
      return function(done) {
        var ctx = this
        function assignResult(result) {
          ctx[resultName] = result
        }

        function executeFunction() {
          if (fn.length === 0) {
            return fn.call(ctx)
          } else {
            return new Promise(function(resolve, reject) {
              fn.call(ctx, function(err, result) {
                if (typeof result !== 'undefined') resolve(result)
                else reject(err)
              })
            })
          }
        }

        Promise.resolve()
          .then(executeFunction)
          .then(assignResult)  // non-promise value or resolved promise value will arrive here
          .catch(assignResult) // thrown Error or rejected Error will arrive here
          .then(done)
      }
    }

    function Then() {
      var label = findFirstThatIsString(arguments)
      var thenFn = findFirstThatIsFunction(arguments)
      var meta = findFirstThatIsPlainObject(arguments)
      var givens = blockManager.allGivens(),
          whens = blockManager.allWhens(),
          invariants = blockManager.allInvariants(),
          ands = blockManager.currentAnds()  // keep reference at this moment. `ands` is a empty array at this moment
      var finalLabel = label || documentationify('Then', thenFn)
      thenFn._keyword = 'Then'
      thenFn._meta = meta
      var finalFn = function(done) {
        // at this moment, all declaration actions are DONE
        // and the suite stack only contain 1 item: the out-most block.
        // so we can not use blockManager anymore
        // now all And are push into `ands` array, this is the time to concat it.
        var ctx = {}
        var runPreparations = function() {
          return givens.concat(whens).reduce(function(p, fn) {
            return p.then(function() {
              if (fn.length === 0) return fn.call(ctx)
              return new Promise(function(resolve, reject) {
                fn.call(ctx, function(err, res) { err ? reject(err) : resolve(res) })
              })
            })
          }, Promise.resolve())
        }
        var runExpectations = function() {
          return invariants.concat(thenFn, ands).reduce(function(p, fn) {
            return p.then(function() {
              if (fn.length === 0) {
                var result = fn.call(ctx)
                if (result === false)
                  throw fn._meta ? createComprehensiveError(fn) : createSimpleError(fn)
                return result
              }
              if (isGoodHabitModeEnabled())
                throw new GoodHabitViolationError('async ' + fn._keyword + ' is discouraged')
              return new Promise(function(resolve, reject) {
                fn.call(ctx, function(err, res) { err ? reject(err) : resolve(res) })
              })
            })
          }, Promise.resolve())
        }

        runPreparations()
          .then(function(){ return runExpectations() })
          .then(function(res){ done() })
          .catch(done)

        function createComprehensiveError(fn) {
          var keyword = fn._keyword,
              meta = fn._meta,
              pos = meta.loc.start.line + ':' + meta.loc.start.column

          var msg = finalLabel + '\n\n'
          msg += '       ' + fn._keyword + ' expression failed at ' + meta.filepath + ':' + pos + '\n'
          if (keyword !== 'Then') {
            msg += '       Failing expression: ' + documentationify(keyword, fn) + '\n'
          }

          if (meta.isBinaryExpression) {
            msg += '       expected: ' + meta.left.call(ctx) + '\n'   // run on same context
            msg += '       to equal: ' + meta.right.call(ctx) + '\n'  // run on same context
          }
          meta.evaluators.forEach(function(obj) {
            var result = obj.evaluator.call(ctx),                     // run on same context
                resultStr
            resultStr = tosource(result).replace(/\n/g, '')
            msg += '         ' + resultStr
            if (resultStr.length > 8) {
              msg += '\n                  '
            } else {
              msg += ' '.repeat(9 - resultStr.length)
            }
            msg += '<- ' + obj.source + '\n'
          })
          return new Error(msg)
        }
        function createSimpleError(fn) {
          var keyword = fn._keyword

          var msg = finalLabel + '\n\n       ' + fn._keyword + ' expression failed.\n'
          if (keyword !== 'Then')
            msg += '       Failing expression: ' + documentationify(keyword, fn) + '\n'

          return new Error(msg)
        }
      }
      addTestCallback(blockManager.currentSuite(), finalLabel, finalFn)
      blockManager.addThenToCurrent(thenFn)
    }

    function Invariant() {
      var fn = findFirstThatIsFunction(arguments)
      var meta = findFirstThatIsPlainObject(arguments)
      fn._keyword = 'Invariant'
      fn._meta = meta
      blockManager.addInvariantToCurrent(fn)
    }

    function And() {
      var fn = findFirstThatIsFunction(arguments)
      var meta = findFirstThatIsPlainObject(arguments)
      fn._keyword = 'And'
      fn._meta = meta
      if (!blockManager.hasAnyThen())
        throw new Error('cannot use And without Then')
      blockManager.addAndToCurrent(fn)
    }

    return {
      describe: describe,
      xdescribe: xdescribe,
      it: it,

      Given: createGivenLikeFunction('Given'),
      Let: createGivenLikeFunction('Let'),
      When: createWhenLikeFunction('When'),
      GIVEN: createWhenLikeFunction('GIVEN'),
      LET: createWhenLikeFunction('LET'),
      Then: Then,
      Invariant: Invariant,
      And: And
    }
  }

}

function findFirstThatIsFunction(arr) {
  return _(arr).find(function (x) {
    return _(x).isFunction()
  })
}

function findFirstThatIsString(arr) {
  return _(arr).find(function (x) {
    return _(x).isString()
  })
}

function findFirstThatIsPlainObject(arr) {
  return _(arr).find(function (x) {
    return _(x).isPlainObject()
  })
}
