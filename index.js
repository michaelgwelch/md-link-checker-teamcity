#! /usr/bin/env node
/* eslint-disable no-console */
const globby = require('globby');
const { promisify } = require('util');
const readFile = promisify(require('fs').readFile);
const markdownLinkCheckOrig = require('markdown-link-check');
const async = require('async');
const _ = require('lodash');
const path = require('path');
const tsm = require('teamcity-service-messages');
const parseArgs = require('minimist');
require('colors'); // magic???
const cp = require('child_process');
const util = require('util');

const exec = util.promisify(cp.exec);

const userArgs = parseArgs(process.argv.slice(2));

const cwd = process.cwd();

/* eslint-disable import/no-dynamic-require */
const whitelist = (userArgs.whitelist) ? _.map(require(path.join(cwd, userArgs.whitelist)), 'link') : [];
/* eslint-enable import/no-dynamic-require */

const mapLimit = promisify(async.mapLimit);

const globPatterns = ['**/*.md', '!**/*icd*.md', '!node_modules/**/*.md'];

const files = globby.sync(globPatterns);

function markdownLinkCheck(file, opts) {
  return new Promise((resolve, reject) => {
    markdownLinkCheckOrig(file, opts, (err, results) => {
      if (err) {
        reject(err);
      } else {
        resolve(results);
      }
    });
  });
}

async function checkLinksInFile(file) {
  try {
    const fullPath = `file:///${path.join(cwd, file)}`;
    const opts = { baseUrl: path.dirname(fullPath) };
    const content = await readFile(file, { encoding: 'utf8' });
    const allLinks = await markdownLinkCheck(content, opts);
    const deadLinks = allLinks
      .filter(link => link.status === 'dead')
      .map(l => ({ file, link: l.link, whitelisted: whitelist.indexOf(l.link) >= 0 }));
    return deadLinks;
  } catch (e) {
    console.log(e);
    return [];
  }
}

async function checkLinksInFiles(files) {
  const result = await mapLimit(files, 10, checkLinksInFile);
  return _.flatten(result).map(value =>
    ({ file: value.file, link: value.link, whitelisted: value.whitelisted }));
}

/**
 * Find all the files that differ from master branch
 */
async function getChangedFiles() {
  const { stdout } = await exec('git diff --name-only master');

  // output will be a list of files: one per line

  return stdout
    .trim()
    .split(/\n/)
    .filter(entry => entry.endsWith('.md'));
}

const allDeadLinks = checkLinksInFiles(files);

const whiteListedDeadLinks = allDeadLinks.then(values => values.filter(v => v.whitelisted));
const notWhiteListedDeadLinks = allDeadLinks.then(values => values.filter(v => !v.whitelisted));

if (userArgs.reporter === 'teamcity') {
  // Register the potential inspection types

  tsm.inspectionType({
    id: 'LINK001', name: 'no-dead-links', description: 'Reports links that were not reachable.', category: 'Document issues',
  });
  tsm.inspectionType({
    id: 'LINK002',
    name: 'no-whitelisted-dead-links',
    description: 'Reports links that were on a whitelist. These are links that we know may not be reachable by an automated build tool. This inspection is just meant as a informational message.',
    category: 'Document issues',
  });

  whiteListedDeadLinks.then((values) => {
    values.forEach(v => tsm.inspection({
      typeId: 'LINK002', message: `Whitelisted dead link: ${v.link}`, file: v.file, SEVERITY: 'INFO',
    }));
  });

  notWhiteListedDeadLinks.then((values) => {
    if (values.length > 0) {
      tsm.buildProblem({ description: 'Dead links detected.' });
    }
    values.forEach(v => tsm.inspection({
      typeId: 'LINK001', message: `Dead link: ${v.link}`, file: v.file, SEVERITY: 'ERROR',
    }));
  });
} else {
  whiteListedDeadLinks.then((values) => {
    if (values.length > 0) {
      console.log('whitelisted:');
    }
    values
      .forEach(value => console.log(`The link '${value.link.yellow}' in file '${value.file.green}' could not be reached.`));
  });

  notWhiteListedDeadLinks.then((values) => {
    if (values.length > 0) {
      console.log('Bad Links'.red);
    }
    values
      .forEach(value => console.log(`The link '${value.link.red}' in file '${value.file.blue}' could not be reached.`));
  });
}
