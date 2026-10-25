# Vendored: omr-homr-ios

Copy of `Packages/omr-homr-ios` from https://github.com/yishengjiang99/omr-sheet-cam at commit
`467308a` (OMR Core owns it; do not edit here, change it upstream and re-vendor). SwiftPM cannot
depend on a subdirectory of a remote repo, so gbk references it as a local path package
(`ios/project.yml` → `packages.OMRHomrIOS.path`).

Update:

```sh
SHA=<new omr-sheet-cam sha>
git -C /path/to/omr-sheet-cam archive $SHA Packages/omr-homr-ios | tar -x --strip-components=1 -C ios/Packages
# then update the SHA above, ios/THIRD_PARTY_NOTICES.md, and ios/models.lock if models.lock changed upstream
```
