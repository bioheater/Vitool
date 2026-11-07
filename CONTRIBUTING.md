# Contributing to Vitool

Thanks for your interest in Vitool! Bug reports and ideas are very welcome.
Code contributions are welcome too, but please read the section about them first.

## Reporting a bug

Please [open an issue](https://github.com/bioheater/Vitool/issues/new) and include:

- your Vitool version (Settings → About Vitool)
- your Windows version
- what you did, step by step
- what you expected and what happened instead
- the exact error message, if there was one
- the link or a description of the file, if it only happens with a certain video

Before opening a new issue, please check whether the problem has already been reported.

## Suggesting a feature

Open an issue and describe what you would like to do and why.
A short example of your use case helps a lot more than a finished solution.

## Contributing code

1. **Open an issue first** and describe the change you have in mind.
   Please wait for a reply before you start working on it, so no effort goes into
   something that does not fit the project.
2. Fork the repository, create a branch and make your change.
3. Keep the pull request focused on one thing and describe what it changes and how you tested it.

Pull requests are reviewed by the maintainer, who decides whether and when they are merged.
A pull request may be closed without being merged.

### License of contributions

Vitool is licensed under the [GNU AGPL-3.0](LICENSE). The maintainer may also offer
Vitool under separate commercial licenses (see [LICENSE-NOTICE.md](LICENSE-NOTICE.md)).

By submitting a pull request, you agree that:

- your contribution is licensed under the AGPL-3.0, and
- you grant the maintainer (bioheater) a perpetual, worldwide, non-exclusive, royalty-free
  and irrevocable license to use, modify, sublicense and distribute your contribution
  under other license terms as well, including commercial licenses, and
- you wrote the contribution yourself or otherwise have the right to submit it under these terms.

If you do not agree, please do not submit a pull request. Opening an issue is always fine.

## Running Vitool from source

You need [Node.js](https://nodejs.org) 20 or newer on Windows.

```bash
git clone https://github.com/bioheater/Vitool.git
cd Vitool
npm install
npm start
```

`npm run installer` builds the Windows installer into `dist`.
The interface texts are written in German in the code and translated in `src/locales/en.json`.
