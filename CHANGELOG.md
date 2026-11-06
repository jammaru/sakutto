# Changelog

Release sections are added by `pnpm release`. Each section lists commit subjects since the previous `vX.Y.Z` tag.

## [0.1.1] - 2026-11-06

- Initial public source release
- Rename the public product to Sakutto.
- Format the store zip example after the package rename.
- Redraw the Sakutto mark as a folded strip.
- Ignore local video renders.
- Restore onboarding after the pinned GGUF commits moved.
- Add Chrome Web Store listing copy and review notes (#3)
- Show a selection icon that translates the highlight immediately (#5)
- Add a manual Chrome Web Store upload workflow. (#4)
- Keep long pages moving while PLaMo translates
- Keep translated text readable and translate whole pages
- Translate pages with PLaMo only, with no 簡易訳 badge or Chrome draft (#8)
- Add a durable page-translation speed bench with headline numbers (#9)
- Fix ranking-table layout collapse and pack short blocks into one request (#10)
- Make whole-page PLaMo translation continuous: one prompt per paragraph, headline first, held tok/s, WebGPU fallback detection (#11)
- Describe PLaMo license terms in onboarding and record consent honestly (#12)
- Serve bundled licences as UTF-8, cover special page prose, add typed translation, clarify licence onboarding (#13)
- Hide start controls until PLaMo can answer, and compare typed text side by side (#14)
- Drop the typed page's outer card and separate the panes with rules
- Keep the local launch-video renders out of git and the linter
