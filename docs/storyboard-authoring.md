# Storyboard authoring

The default workspace now organizes a video as named explanation beats. The timeline remains available from the toolbar for precise timing. All views edit the same scene document and use Manim's native execution, rendering, and animation classes.

## Make an explanation

1. Start from **Home → From secant to tangent**, or open `examples/storyboard_derivative.manimstudio`.
2. Choose an explanation card. Rename it to describe what the viewer learns.
3. Use **Start** and **Result** to inspect its actual native states. **Preview beat** plays that explanation; the local progress control inspects intermediate frames.
4. Build with the existing drawing tools, contextual construction actions, or **Library**.
5. Use **Edit result** to record a move, resize, or rotation from the canvas. The initial object stays unchanged. Rotation uses `Rotate`, and path motion uses `MoveAlongPath` rather than guessing a trajectory from endpoints.
6. In **Actions**, add reveals, morphs, replacements, parameter changes, emphasis, and holds. Switch coordination between Together, Then, and Stagger; select nested actions to edit their complete Manim arguments in the inspector. Repeat wraps the current actions in a native loop.
7. In **Relationships**, try a parameter through a slider. This is an uncommitted result preview, computed by Manim. Save a parameter sweep to animate to that value, or discard it. Select construction nodes to inspect their mathematical bindings.
8. In **Script**, write the narration and attach phrases to an action's start/end. Offsets are in seconds. Attach a local audio file at the beat's start to include it in the exported Manim video.
9. In **Equations**, edit formula states, split them into terms, and connect two states through explicit term correspondences. This controls visual movement, not algebraic validity.
10. In **Recipes**, insert existing reusable constructions with exposed inputs, or save a selection and its actions as a recipe.

Cards can be split at whole statement boundaries or joined without changing execution. Earlier/Later permits independent beats to move, and explains conflicts for shared objects, dependencies, or opaque Python. Removing an action preserves the beat's explanation text. Undo/redo covers authored structure and native animation edits.

## Data and fidelity

`SceneDoc.storyboard` is optional editor metadata: beat IDs, titles, ordered step IDs, script text, and manually aligned phrase cues. It does not replace the ordered `construct()` statement model. Selecting views or changing narration does not rewrite Python or invalidate native preview videos. Metadata is saved in `.manimstudio`, preserved when applying code edits with the current document as the import base, and normalized after statement edits. Standalone Python exports contain the native scene; reopening only that Python reconstructs default beats because editor metadata is stored in the project.

Start/Result previews stop at an explicit statement ID and edge. Timestamps alone cannot distinguish consecutive `add`/`remove`/assignment actions at the same time. Preview hooks stop before or after the chosen native statement, including before a whole compound block and after all its iterations. They are absent from exported code.

The reordering check is deliberately conservative. Shared construction inputs and formula destinations count as dependencies. Arbitrary Python, scene control, custom scene members, and procedural updaters require source-level review rather than an inferred safe reorder. Imported code remains accessible through Code.

Narration cues currently provide manual phrase/action alignment and preview navigation. Audio mixes in the exported video; the live canvas preview remains muted. Automatic transcription, speech generation, and word-aligned Manim Voiceover integration are not included. Unpaired equation terms fade according to the existing native term-transform implementation. Parameter and object state observations are partial native measurements, not complete serialized snapshots.

## Verification

`tests/test_storyboard.py` exercises partitioning, empty planning cards, whole-block splits, dependency checks, measured timings, exact instant-action boundaries, completed animation states, save/reopen/code-edit persistence, canvas result recording, parameter sweeps, undo/redo, and render fingerprint stability. Existing import, timeline, keyframe, native parity, and sample tests cover the shared execution path. `frontend/scripts/storyboard_ops.mjs` and `storyboard_store.mjs` invoke the actual frontend authoring modules from those tests.
