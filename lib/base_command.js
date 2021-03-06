'use strict';

const inquirer = require('inquirer');
const path = require('path');
const fs = require('mz/fs');
const mkdirp = require('mkdirp');
const BaseCommand = require('common-bin').Command;
const ConsoleLogger = require('zlogger');
const chalk = require('chalk');
const runscript = require('runscript');
const through = require('through2');
const giturl = require('giturl');
const Cache = require('./cache');


const configDir = path.join(process.env.HOME, '.projj');
const configPath = path.join(configDir, 'config.json');
const cachePath = path.join(configDir, 'cache.json');
const consoleLogger = new ConsoleLogger({
  time: false,
});

const defaults = {
  base: `${process.env.HOME}/projj`,
  hooks: {},
  alias: {
    'github://': 'https://github.com/',
  },
};

class Command extends BaseCommand {

  constructor() {
    super();
    this.logger = new ConsoleLogger({
      prefix: chalk.green('✔︎  '),
      time: false,
    });
    this.childLogger = new ConsoleLogger({
      prefix: '   ',
      time: false,
      stdout: colorStream(process.stdout),
      stderr: colorStream(process.stderr),
    });
    this.cache = new Cache({ cachePath });
  }

  * run(cwd, args) {
    try {
      yield this.init();
      yield this._run(cwd, args);
      consoleLogger.info('✨  Done');
    } catch (err) {
      this.error(err.message);
      // this.logger.error(err.stack);
      process.exit(1);
    }
  }

  * init() {
    yield this.loadConfig();
    yield this.cache.get();
  }

  * loadConfig() {
    yield mkdir(configDir);
    const configExists = yield fs.exists(configPath);
    let config;
    if (configExists) {
      config = yield readJSON(configPath);
      config = resolveConfig(config, defaults);
      // ignore when base has been defined in ~/.projj/config
      if (config.base) {
        this.config = config;
        return;
      }
    }

    const question = {
      type: 'input',
      name: 'base',
      message: 'Set base directory:',
      default: defaults.base,
    };
    const { base } = yield inquirer.prompt([ question ]);
    this.config = resolveConfig({ base }, defaults);
    yield fs.writeFile(configPath, JSON.stringify(this.config, null, 2));
  }

  * runHook(name, cacheKey) {
    if (!this.config.hooks[name]) return;
    const hook = this.config.hooks[name];
    const env = {
      PATH: `${configDir}/hooks:${process.env.PATH}`,
      PROJJ_HOOK_NAME: name,
    };
    if (this.config[name]) {
      env.PROJJ_HOOK_CONFIG = JSON.stringify(this.config[name]);
    }
    const opt = {
      env: Object.assign({}, process.env, env),
    };

    let cwd;
    if (yield this.cache.get(cacheKey)) {
      cwd = path.join(this.config.base, cacheKey);
    } else {
      cwd = cacheKey;
    }
    if (cwd && (yield fs.exists(cwd))) opt.cwd = cwd;

    this.logger.info('Run hook %s for %s', chalk.green(name), cacheKey);
    yield this.runScript(hook, opt);
  }

  * runScript(cmd, opt) {
    const stdout = through();
    stdout.pipe(this.childLogger.stdout, { end: false });
    opt = Object.assign({}, {
      stdio: 'pipe',
      stdout,
    }, opt);
    try {
      yield runscript(cmd, opt);
    } catch (err) {
      const stderr = err.stdio.stderr;
      if (stderr) {
        this.childLogger.info(stderr.toString());
      }
      throw err;
    }
  }

  error(msg) {
    consoleLogger.error(chalk.red('✘  ' + msg));
  }

  // https://github.com/popomore/projj.git
  // => $BASE/github.com/popomore/projj
  url2dir(url) {
    url = giturl.parse(url);
    return url.replace(/https?:\/\//, '');
  }

  * addRepo(repo, cacheKey) {
    // preadd hook
    yield this.runHook('preadd', cacheKey);

    const targetPath = path.join(this.config.base, cacheKey);
    this.logger.info('Cloning into %s', chalk.green(targetPath));

    const env = Object.assign({
      GIT_SSH: path.join(__dirname, 'ssh.js'),
    }, process.env);
    yield this.runScript(`git clone ${repo} ${targetPath} > /dev/null`, {
      env,
    });
    // add this repository to cache.json
    yield this.cache.set(cacheKey, { repo });
    yield this.cache.dump();

    // preadd hook
    yield this.runHook('postadd', cacheKey);
  }
}

module.exports = Command;

function* readJSON(configPath) {
  const content = yield fs.readFile(configPath);
  return JSON.parse(content);
}

function resolveConfig(config, defaults) {
  config = Object.assign({}, defaults, config);
  switch (config.base[0]) {
    case '.':
      config.base = path.join(path.dirname(configPath), config.base);
      break;
    case '~':
      config.base = config.base.replace('~', process.env.HOME);
      break;
    case '/':
      break;
    default:
      config.base = path.join(process.cwd(), config.base);
  }
  return config;
}

function mkdir(file) {
  return new Promise((resolve, reject) => {
    mkdirp(file, err => {
      err ? reject(err) : resolve();
    });
  });
}

function colorStream(stream) {
  const s = through(function(buf, _, done) {
    done(null, chalk.gray(buf.toString()));
  });
  s.pipe(stream);
  return s;
}
