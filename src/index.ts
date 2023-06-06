import * as core from '@actions/core';
import * as github from '@actions/github';
import { minimatch } from 'minimatch';
import { load } from 'js-yaml';
import { readFileSync } from 'fs';

type Reviewer = {
  name: string;
  paths?: string[];
  team?: boolean;
};

type Ignore = {
  authors?: string[];
  titles?: string[];
};

type Config = {
  reviewers: Reviewer[];
  ignore?: Ignore;
};

async function run() {
  try {
    if (github.context.eventName !== 'pull_request') {
      core.setFailed(`This action only supports pull_request event`);
      return;
    }

    const configFilePath = core.getInput('config-file-path');
    const config = load(readFileSync(configFilePath, 'utf8')) as Config;
    if (config.ignore && !validateByIgnore(config.ignore)) {
      return;
    }

    const token = core.getInput('token');
    const octokit = github.getOctokit(token);
    const { owner, repo, number } = github.context.issue;
    const { data } = await octokit.rest.pulls.get({
      owner: owner,
      repo: repo,
      pull_number: number,
    });
    if (data.state !== 'open') {
      core.info('This pull request is not open');
      return;
    }

    const {
      data: { files },
    } = await octokit.rest.repos.compareCommits({
      owner: owner,
      repo: repo,
      base: data.base.ref,
      head: data.head.ref,
    });
    if (!files) {
      core.info('No files changed');
      return;
    }
    const filenames = files.map((file) => file.filename);
    const { users, teams } = getReviewers(filenames, config);
    core.info(`User reviewers: ${users}`);
    core.info(`Team reviewers: ${teams}`);
    octokit.rest.pulls.requestReviewers({
      owner: owner,
      repo: repo,
      pull_number: number,
      reviewers: Array.from(users),
      team_reviewers: Array.from(teams),
    });
  } catch (error) {
    core.setFailed(
      error instanceof Error ? error.message : JSON.stringify(error)
    );
  }
}

function validateByIgnore(ignore: Ignore): boolean {
  if (ignore.authors?.includes(github.context.actor)) {
    core.info(`Ignored author: ${github.context.actor}`);
    return false;
  }

  let isIgnoredByTitle = false;
  const title = github.context.payload.pull_request?.title;
  ignore.titles?.some((ignoreTitle) => {
    if (title.includes(ignoreTitle)) {
      core.info(`Ignored title: ${title}`);
      isIgnoredByTitle = true;
      return true;
    }
  });
  return !isIgnoredByTitle;
}

function getReviewers(
  filenames: string[],
  config: Config
): { users: string[]; teams: string[] } {
  const users = new Set<string>();
  const teams = new Set<string>();
  config.reviewers
    .filter((reviewer) => {
      return reviewer.name !== github.context.actor;
    })
    .forEach((reviewer) => {
      if (!reviewer.paths) {
        // if path is empty, always add reviewer
        if (reviewer.team) {
          teams.add(reviewer.name);
        } else {
          users.add(reviewer.name);
        }
        return;
      }
      reviewer.paths.some((path) => {
        const matchedFiles = filenames.filter(
          minimatch.filter(path, { matchBase: true })
        );
        if (matchedFiles.length > 0) {
          if (reviewer.team) {
            teams.add(reviewer.name);
          } else {
            users.add(reviewer.name);
          }
          return true;
        }
      });
    });
  return { users: Array.from(users), teams: Array.from(teams) };
}

run();
