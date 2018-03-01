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
require('colors'); // magic that allows us to use colors in our console output
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

const allMarkdownFilesPromise = globby(globPatterns);

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

// files is a promise<[string]>
async function checkLinksInFiles(filesToCheckPromise) {
  const filesToCheck = await filesToCheckPromise;
  const result = await mapLimit(filesToCheck, 10, checkLinksInFile);
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

async function main() {
  const allDeadLinks = await checkLinksInFiles(allMarkdownFilesPromise);

  const whiteListedDeadLinks = allDeadLinks.filter(v => v.whitelisted);
  const notWhiteListedDeadLinks = allDeadLinks.filter(v => !v.whitelisted);

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

    whiteListedDeadLinks.forEach(v => tsm.inspection({
      typeId: 'LINK002', message: `Whitelisted dead link: ${v.link}`, file: v.file, SEVERITY: 'INFO',
    }));

    if (notWhiteListedDeadLinks.length > 0) {
      tsm.buildProblem({ description: 'Dead links detected.' });
    }
    notWhiteListedDeadLinks.forEach(v => tsm.inspection({
      typeId: 'LINK001', message: `Dead link: ${v.link}`, file: v.file, SEVERITY: 'ERROR',
    }));
  } else {
    whiteListedDeadLinks
      .forEach(value => console.log(`WARN: '${value.link.yellow}' in file '${value.file.green}' could not be reached but is whitelisted.`));

    notWhiteListedDeadLinks
      .forEach(value => console.log(`ERROR: '${value.link.red}' in file '${value.file.blue}' could not be reached.`));
  }
}

main();
