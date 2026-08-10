# Mesa SDKs

Public source snapshots for the official Mesa SDKs:

- [`@mesadev/sdk`](./typescript) for TypeScript
- [`mesa-sdk`](./python) for Python

Install the released packages from [npm](https://www.npmjs.com/package/@mesadev/sdk) or
[PyPI](https://pypi.org/project/mesa-sdk/).

This repository is synchronized from Mesa's production release source. Direct changes to mirrored files are
replaced by the next production deployment. Open an issue in this repository to report an SDK problem or request a
feature.

The Python snapshot contains the public Python layer and type declarations. Mesa publishes its native module as part
of each platform wheel. Release builds run from Mesa's main development repository, so these snapshots can reference
build inputs that are outside this repository.
