# Repository Instructions

## Version Updates

- Do not upgrade dependencies, SDKs, package-manager metadata, or tool versions to a release that is less than 14 full days old.
- Before changing any version, verify the candidate release date from an authoritative source such as the package registry or upstream release page.
- Prefer pinned versions over `latest` tags or broad semver ranges when updating versions.
- Record the checked release date and source in the change summary whenever a version is bumped.
- This waiting period is required to reduce supply-chain and network-attack exposure from newly published packages.
