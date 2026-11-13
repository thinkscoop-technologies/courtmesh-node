# Releasing @courtmesh/sdk

Releases are published by GitHub Actions when a `v*` tag is pushed. The workflow is `.github/workflows/publish.yml`; it checks that the tag matches `package.json`, runs the typecheck and tests, builds, and runs `npm publish --access public --provenance`.

## One time setup (a human with the right accounts)

1. Create the npm organization `courtmesh` at https://www.npmjs.com/org/create (free plan is enough for public packages). Add the people who may publish as members with the owner or admin role.
2. On npm, create an automation access token (Account menu, Access Tokens, Generate New Token, Classic, type Automation) or a granular token with read and write on the `@courtmesh` scope. An automation token bypasses two factor prompts, which CI needs.
3. In GitHub, open `thinkscoop-technologies/courtmesh-node`, Settings, Secrets and variables, Actions, New repository secret. Name it `NPM_TOKEN` and paste the token.
4. Make sure the repository is public. npm provenance requires a public repository and the `id-token: write` permission already set in the workflow.

## Every release

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Run the checks locally:

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run build
   npm pack --dry-run
   ```

3. Merge to `main`.
4. Tag and push the tag (the tag must be `v` plus the exact `package.json` version):

   ```bash
   git checkout main && git pull
   git tag v0.6.0
   git push origin v0.6.0
   ```

5. Watch the Publish workflow. When it is green, confirm with `npm view @courtmesh/sdk version`.

## If a release goes wrong

A published npm version cannot be replaced. Fix forward with a new patch version. Within 72 hours of publishing you can `npm unpublish @courtmesh/sdk@<version>` if nothing depends on it; otherwise use `npm deprecate`.
