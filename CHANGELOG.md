# Changelog

## [2.1.3](https://github.com/chrischall/splitwise-mcp/compare/v2.1.2...v2.1.3) (2026-07-20)


### Documentation

* correct the connector deploy runbook ([#99](https://github.com/chrischall/splitwise-mcp/issues/99)) ([bcb32cc](https://github.com/chrischall/splitwise-mcp/commit/bcb32cc66f8e4955b85fd8e7d06e35658471267e))

## [2.1.2](https://github.com/chrischall/splitwise-mcp/compare/v2.1.1...v2.1.2) (2026-07-19)


### Bug Fixes

* **deps:** move to workers-oauth-provider 0.8.x and mcp-connector 1.0.0 ([#94](https://github.com/chrischall/splitwise-mcp/issues/94)) ([fcd874d](https://github.com/chrischall/splitwise-mcp/commit/fcd874dbaf8988cab257882221e00617aed1a03c))

## [2.1.1](https://github.com/chrischall/splitwise-mcp/compare/v2.1.0...v2.1.1) (2026-07-19)


### Bug Fixes

* **ci:** run the Workers test pool in CI ([#91](https://github.com/chrischall/splitwise-mcp/issues/91)) ([d66dfd2](https://github.com/chrischall/splitwise-mcp/commit/d66dfd229c6ed11665628ebc4fa70160d023a24e))


### Documentation

* replace duplicated fleet policy with a pointer ([#89](https://github.com/chrischall/splitwise-mcp/issues/89)) ([b3656db](https://github.com/chrischall/splitwise-mcp/commit/b3656db7305ff6d81a861cb01d1c219856ead474))

## [2.1.0](https://github.com/chrischall/splitwise-mcp/compare/v2.0.12...v2.1.0) (2026-07-14)


### Features

* add hosted Cloudflare Worker connector (full-write) ([#86](https://github.com/chrischall/splitwise-mcp/issues/86)) ([e98c3bb](https://github.com/chrischall/splitwise-mcp/commit/e98c3bb87943f6bfacd5e744f6e06707436af789))


### Bug Fixes

* guard client.ts .env load so the Worker starts + wire OAUTH_KV id ([#88](https://github.com/chrischall/splitwise-mcp/issues/88)) ([6e0e34e](https://github.com/chrischall/splitwise-mcp/commit/6e0e34ea65565c5a38f78d27bc778172b41b5df6))


### Refactor

* pass client into tool registrars (transport-neutral) ([#83](https://github.com/chrischall/splitwise-mcp/issues/83)) ([2a9cb11](https://github.com/chrischall/splitwise-mcp/commit/2a9cb11fe9954b34666f689eb7794f3511181daf))

## [2.0.12](https://github.com/chrischall/splitwise-mcp/compare/v2.0.11...v2.0.12) (2026-07-13)


### Bug Fixes

* **plugin:** move SKILL.md into skills/ directory so plugin skills load ([#81](https://github.com/chrischall/splitwise-mcp/issues/81)) ([067a811](https://github.com/chrischall/splitwise-mcp/commit/067a811d48494a93f3bbc7e59e6eb5173701d1b6))

## [2.0.11](https://github.com/chrischall/splitwise-mcp/compare/v2.0.10...v2.0.11) (2026-07-07)


### Bug Fixes

* bump @chrischall/mcp-utils to 0.12.0 ([#76](https://github.com/chrischall/splitwise-mcp/issues/76)) ([e7de54b](https://github.com/chrischall/splitwise-mcp/commit/e7de54be4fbe7b00e71c2a7a1149e82b8753de76))
* confirm-gate Splitwise write tools ([#72](https://github.com/chrischall/splitwise-mcp/issues/72)) ([a912419](https://github.com/chrischall/splitwise-mcp/commit/a9124197c5e0fd4e0d52f93d720a8f82027da6ec))
* consistent confirm-gate descriptions/annotations for Splitwise writes ([#75](https://github.com/chrischall/splitwise-mcp/issues/75)) ([1c0a8c3](https://github.com/chrischall/splitwise-mcp/commit/1c0a8c372fae13972ac30cb023fef03212db1946))


### Documentation

* document first-party dependency-bump label exception ([#77](https://github.com/chrischall/splitwise-mcp/issues/77)) ([a31779a](https://github.com/chrischall/splitwise-mcp/commit/a31779a8d97330197fe0af6a61670164875a5d2a))

## [2.0.10](https://github.com/chrischall/splitwise-mcp/compare/v2.0.9...v2.0.10) (2026-07-05)


### Documentation

* refresh CLAUDE.md for mcp-utils architecture + auto-review follow-ups ([#62](https://github.com/chrischall/splitwise-mcp/issues/62)) ([ad2a1da](https://github.com/chrischall/splitwise-mcp/commit/ad2a1daae5ba5bdf2c88d2e2c55ce4cde397a7da))
* require Conventional Commit PR titles for release-please ([#58](https://github.com/chrischall/splitwise-mcp/issues/58)) ([646a633](https://github.com/chrischall/splitwise-mcp/commit/646a633b016580f2a27dfb714157754ace4fe133))

## [2.0.9](https://github.com/chrischall/splitwise-mcp/compare/v2.0.8...v2.0.9) (2026-06-13)


### Bug Fixes

* bot PRs bypass the CI gate unconditionally (upstream curtaincall[#86](https://github.com/chrischall/splitwise-mcp/issues/86) review) ([#54](https://github.com/chrischall/splitwise-mcp/issues/54)) ([2e34581](https://github.com/chrischall/splitwise-mcp/commit/2e34581837c215f17dc5d815b54c860d22a85adf))


### Documentation

* add MIT LICENSE file and README badges ([#52](https://github.com/chrischall/splitwise-mcp/issues/52)) ([46d8bea](https://github.com/chrischall/splitwise-mcp/commit/46d8bea6726569a673f98e8c1d95b81d905a5551))
* correct Versioning section to describe release-please ([#50](https://github.com/chrischall/splitwise-mcp/issues/50)) ([0918780](https://github.com/chrischall/splitwise-mcp/commit/0918780e527beea3f8accaf116343c82c672902f))

## [2.0.8](https://github.com/chrischall/splitwise-mcp/compare/v2.0.7...v2.0.8) (2026-05-29)


### Bug Fixes

* **ci:** auto-merge arm guards ([#33](https://github.com/chrischall/splitwise-mcp/issues/33)) ([bff71b6](https://github.com/chrischall/splitwise-mcp/commit/bff71b6481699433e134170b75f3dbf3932ba7f5))

## [2.0.7](https://github.com/chrischall/splitwise-mcp/compare/v2.0.6...v2.0.7) (2026-05-26)


### Bug Fixes

* **ci:** substitute repo name in publish workflow ([#30](https://github.com/chrischall/splitwise-mcp/issues/30)) ([930b437](https://github.com/chrischall/splitwise-mcp/commit/930b437d239ef5e9f21df1398e6a9e3a37473108))

## [2.0.6](https://github.com/chrischall/splitwise-mcp/compare/v2.0.5...v2.0.6) (2026-05-26)


### Documentation

* **claude:** warn against opening PRs before the feature is done ([#28](https://github.com/chrischall/splitwise-mcp/issues/28)) ([c6f9f90](https://github.com/chrischall/splitwise-mcp/commit/c6f9f90bc6852e0dc9ccacf5a3630362788928e3))

## [2.0.5](https://github.com/chrischall/splitwise-mcp/compare/v2.0.4...v2.0.5) (2026-05-25)


### Bug Fixes

* **ci:** prevent labeled event from cancelling auto-review ([#26](https://github.com/chrischall/splitwise-mcp/issues/26)) ([a18fd97](https://github.com/chrischall/splitwise-mcp/commit/a18fd97ed74332f5a551cbe2ab8ce18702e4c46b))

## [2.0.4](https://github.com/chrischall/splitwise-mcp/compare/v2.0.3...v2.0.4) (2026-05-24)


### Documentation

* add Acknowledgement of Terms section to README ([#21](https://github.com/chrischall/splitwise-mcp/issues/21)) ([ca50d85](https://github.com/chrischall/splitwise-mcp/commit/ca50d8526eac0c880ceae1e41fef210919ffe647))
* canonical auto-merge guidance ([#24](https://github.com/chrischall/splitwise-mcp/issues/24)) ([d0c743c](https://github.com/chrischall/splitwise-mcp/commit/d0c743cd1cd3d3841d47657e2118b98551095953))
* **claude-md:** call out 100-char limit on server.json description ([e6a6254](https://github.com/chrischall/splitwise-mcp/commit/e6a6254254d3b8dcaa94af6ecc309ba56121eb6b))
* **claude-md:** call out 100-char limit on server.json description ([6c47286](https://github.com/chrischall/splitwise-mcp/commit/6c472862fe7be344d9b418ccf9642a6383253d64))
