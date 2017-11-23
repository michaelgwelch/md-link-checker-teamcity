# Sample Document

This link to [GitHub](https://github.com) should be reachable.

This link to [nothing](https://__nothing_garbage.com) should cause a bad link to be reported and fail the build if `--reporter=teamcity` is specified.

This link to [whitelisted](https://__whitelisted_garbage.com) should cause a bad link to be reported and it will fail the build if `--reporter=teamcity` is specified **unless** the `--whitelist=sample/sample-whitelist.json` option is used.