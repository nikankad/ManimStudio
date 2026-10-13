# PR 2 audit

Reviewed PR 2 at `dfff6c7261e2e03a798fc63a2afc20783ddea5f5`, with main at
`a5c7cff1e29704acc4ad6db4d1250319efb41ac1`. The README conflict was resolved using
main's shortened document. Changes are committed to the PR branch before merging.

## Bugs fixed

| Area | Failure | Fix and regression coverage |
| --- | --- | --- |
| Saving | A delayed save marked later edits as saved; overlapping saves could overwrite newer work. | Serialize saves, snapshot after the file chooser, and clear the unsaved flag only for the document written. Browser checks verify saved data, recovery, queued saves and switching projects. |
| Code editing | Delayed import or code-generation responses replaced newer timeline edits or another project's code. | Check the project epoch, document identity and generation request before applying responses. Browser checks hold real API responses during edits and project switches. |
| Render concurrency | Same-project jobs overwrote the shared script, final video and cache while another render was using them. | Serialize each project's renders through result copying. Keep a separate video for every job within the bounded media cache. A concurrent real-render test verifies distinct frame counts and colors. |
| Cancellation | A job cancelled before its worker started could become running again; cancellation between setup and process creation could leave Manim alive. | Preserve cancellation under a process lock, checking before worker setup and subprocess creation. Test cancellation before starting a worker. |
| Export quality | Imported module configuration undid the export dialog's dimensions and frame rate. | Apply the selected output settings after the module's preserved configuration. Real MP4 tests inspect dimensions and frame rate for preview and project quality. |
| Keyframe timing | A key at a group's end could use the default one-second length; releasing a shared duration exposed overridden sibling durations. | Give every added key its required duration and retain each sibling's effective timing. Cover short and long groups, shared and individual durations. |
| Keyframe endpoints | Repeated methods exposed intermediate values; edits or deletion changed the wrong endpoint. Returning easing contaminated later keys. | Aggregate one endpoint per channel and clip, edit its final writer, and use measured/known easing endpoints. Cover repeated shifts, scales, rotations, tracker increments, colors and opacity, returning/custom easing and transformed translations. |
| Stroke key deletion | Removing a width key also removed color set in the same method call, or vice versa. | Preserve the other arguments with Manim's `None` default and omit unchanged properties from the keyframe list. Native endpoint and source round-trip tests cover both deletions. |
| LaTeX fallback | Moving source between environments could remove or duplicate the number fallback. | Preserve an explicit fallback exactly once, including after header edits; test both environment modes. |
| Math expressions | Graph comparisons containing `=` were treated as assignments; zero-input functions could not be called; reserved sum indices generated broken Python. | Distinguish assignments from comparisons, accept empty argument lists when valid, and validate generated-code names. Test graph analysis, evaluation and invalid indices. |
| Toolbar | Export, Settings and Help overflowed at 1024 px with a long filename. | Allow the filename and spacer to shrink and correct compact spacing. Check button bounds from 1000 to 1700 px. |

## Validation

- Full Python suite: **279 passed**. The subsequent stroke deletion change passes the
  **32-test keyframe suite**, including two additional regressions (281 total tests).
- Frontend type check and production build pass; packaged web assets are rebuilt.
- All **37 browser workflow scenarios** pass across the audit runs, including real
  video export and axe-core accessibility checks. Failed expectations using old clip
  names were corrected and rerun.
- All **five delayed save/import browser regressions** pass.
- The construction assertion responsible for main's failing Release test job now
  checks Python syntax structure rather than line wrapping. Preference tests wait
  for persistence; the browser runner closes contexts and prints failure traces.

Validation used Linux, Python 3.12, Node, Chromium, real Manim and installed LaTeX.
The full external import-fidelity corpus and platform packaging were not rerun.
