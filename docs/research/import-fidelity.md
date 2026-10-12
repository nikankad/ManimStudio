# Import fidelity

How much of real manim code becomes an editable scene, measured by `scripts/import_fidelity.py` (manim 0.22.0, 15 fps, 192×108). Scenes manim itself can't render here (no LaTeX on this machine, OpenGL only, missing asset files) are skipped and left out of the numbers.

Reading the numbers: a statement kept as a code step still runs exactly as written (the parity rows), but the editor can't show or change what it does: its objects aren't in the scene's object list, its animations have no keyframe rows. So the share of statements on the timeline is how much of a project is editable, and parity is how much of it is safe.

## Project-shaped files (scripts/fidelity_corpus)

| | |
|---|---|
| Scenes | 5 (1 skipped: manim can't render them here) |
| Imported | 4 of 4 |
| construct() statements on the timeline (not code steps) | **87%** (41 of 47) |
| Scenes with no code steps at all | 25% (1 of 4) |
| Animations whose target is one of the scene's objects (keyframe rows) | 59% (16 of 27) |
| Regenerated code: same length and plays as the original under manim | 100% (4 of 4; 0 failed to run) |
| Regenerated code: same frame at the end of every play and wait, pixel for pixel | 100% (4 of 4; 4 of these scenes show something) |
| Editor preview: same length as manim | 100% (4 of 4) |
| Regenerated construct() is the same Python (AST) | 50% (2 of 4; the others: 2 split chains) |

## This repository's examples/

| | |
|---|---|
| Scenes | 2 (0 skipped: manim can't render them here) |
| Imported | 2 of 2 |
| construct() statements on the timeline (not code steps) | **93%** (140 of 150) |
| Scenes with no code steps at all | 0% (0 of 2) |
| Animations whose target is one of the scene's objects (keyframe rows) | 74% (53 of 72) |
| Regenerated code: same length and plays as the original under manim | 100% (2 of 2; 0 failed to run) |
| Regenerated code: same frame at the end of every play and wait, pixel for pixel | 100% (2 of 2; 2 of these scenes show something) |
| Editor preview: same length as manim | 100% (2 of 2) |
| Regenerated construct() is the same Python (AST) | 0% (0 of 2; the others: 2 split chains) |

## manim's documentation examples

| | |
|---|---|
| Scenes | 383 (119 skipped: manim can't render them here) |
| Imported | 264 of 264 |
| construct() statements on the timeline (not code steps) | **78%** (1130 of 1443) |
| Scenes with no code steps at all | 51% (135 of 264) |
| Animations whose target is one of the scene's objects (keyframe rows) | 66% (117 of 177) |
| Regenerated code: same length and plays as the original under manim | 100% (264 of 264; 0 failed to run) |
| Regenerated code: same frame at the end of every play and wait, pixel for pixel | 100% (264 of 264; 260 of these scenes show something) |
| Editor preview: same length as manim | 100% (264 of 264) |
| Regenerated construct() is the same Python (AST) | 53% (141 of 264; the others: 76 split chains, 30 keywords, 17 split chains + keywords) |

## Keyframes (all imported scenes)

| Channel | Keyframes | Editable in Effect Controls |
|---|---|---|
| position | 28 | 64% (18) |
| scale | 8 | 100% (8) |
| rotation | 11 | 100% (11) |
| opacity | 1 | 100% (1) |
| color | 3 | 67% (2) |
| value | 7 | 43% (3) |

Why a keyframe is read-only:

- 8× The value is an expression (…): edit it in the code
- 3× Measuring where it starts…
- 3× .to_edge(…) places it relative to something else: edit it in the code
- 1× .set_fill(…) here doesn't set a colour

## What the importer keeps as code

Statements of construct() kept as code steps, by kind:

- 74× plain value (number, list, dict, lambda…)
- 66× method call on an object, later in the scene (.set_color, .next_to, .move_to…)
- 48× object built by a call the importer doesn't take (a method, a helper function, *args…)
- 32× method call on an expression (VGroup(...).arrange(), group[0].shift()…)
- 27× loop
- 20× self.add(…) with computed arguments
- 20× self.play(…) with computed arguments
- 10× updater
- 8× assignment to an attribute, item or several names
- 7× function definition
- 7× list comprehension
- 4× Expr
- 4× other assignment
- 2× += / -=

The importer's own notes:

- 20× Line …: this self.play is kept as code (its animations are built by an expression, such as a list or a variable).

## Animation classes on the timeline

animate 80, Write 39, FadeIn 26, Create 24, FadeOut 13, LaggedStartMap 8, Indicate 7, Rotate 6, Uncreate 6, Wiggle 6, FadeTransform 5, Blink 3, MoveAlongPath 3, Rotating 3, ChangeSpeed 3, Restore 3, Unwrite 3, Wait 2, Add 2, DrawBorderThenFill 2, GrowFromCenter 2, Transform 2, ApplyMatrix 2, TransformMatchingShapes 2, TransformFromCopy 2, AnimationGroup 1, Succession 1, ShowIncreasingSubsets 1, TypeWithCursor 1, UntypeWithCursor 1

## Skipped (manim can't render them here)

- 101× FileNotFoundError: [Errno 2] No such file or directory: …
- 9× ImportError: TypstMobject requires the … Python package. Install it with:  pip install typst>=0.14
- 8× NameError: name … is not defined
- 1× ModuleNotFoundError: No module named …
- 1× OSError: From: /home/user/ManimStudio/.claude/worktrees/ux-workflow, could not find click.wav at eit

## Failures

None.

## Per scene

| File | Scene | Statements on timeline | Anims on objects | Regenerated = original | Same AST |
|---|---|---|---|---|---|
| animation__LagRatios.py | LagRatios | 3/8 | 0/2 | yes | yes |
| animation__ChangeDefaultAnimation.py | ChangeDefaultAnimation | 4/8 | 2/2 | yes | yes |
| animation__DefaultAddScene.py | DefaultAddScene | 7/7 | 2/5 | yes | split chains |
| animation__AddWithRunTimeScene.py | AddWithRunTimeScene | 3/3 | 0/1 | yes | split chains |
| animation__OverrideAnimationExample.py | OverrideAnimationExample | 1/1 | 0/1 | yes | yes |
| changing__AnimatedBoundaryExample.py | AnimatedBoundaryExample | 4/4 | 0/0 | yes | yes |
| changing__TracedPathExample.py | TracedPathExample | 6/7 | 1/1 | yes | split chains |
| changing__DissipatingPathExample.py | DissipatingPathExample | 6/6 | 2/2 | yes | yes |
| composition__SuccessionExample.py | SuccessionExample | 6/6 | 4/4 | yes | yes |
| composition__LaggedStartExample.py | LaggedStartExample | 8/8 | 3/3 | yes | split chains |
| creation__CreateScene.py | CreateScene | 1/1 | 0/1 | yes | yes |
| creation__ShowUncreate.py | ShowUncreate | 1/1 | 0/1 | yes | yes |
| creation__ShowDrawBorderThenFill.py | ShowDrawBorderThenFill | 1/1 | 0/1 | yes | yes |
| creation__ShowWrite.py | ShowWrite | 1/1 | 0/1 | yes | yes |
| creation__ShowWriteReversed.py | ShowWriteReversed | 1/1 | 0/1 | yes | yes |
| creation__ShowIncreasingSubsetsScene.py | ShowIncreasingSubsetsScene | 4/4 | 1/1 | yes | yes |
| creation__InsertingTextExample.py | InsertingTextExample | 4/4 | 2/2 | yes | split chains |
| creation__DeletingTextExample.py | DeletingTextExample | 4/4 | 2/2 | yes | split chains |
| growing__Growing.py | Growing | 10/12 | 5/5 | yes | yes |
| indication__FlashOnCircle.py | FlashOnCircle | 3/4 | 1/1 | yes | yes |
| indication__BlinkingExample.py | BlinkingExample | 3/3 | 1/1 | yes | split chains |
| movement__HomotopyExample.py | HomotopyExample | 2/3 | 1/1 | yes | yes |
| movement__MoveAlongPathExample.py | MoveAlongPathExample | 5/6 | 1/1 | yes | split chains + keywords |
| rotation__RotatingDemo.py | RotatingDemo | 9/12 | 4/4 | yes | yes |
| rotation__RotatingDifferentAxis.py | RotatingDifferentAxis | 7/11 | 0/0 | yes | yes |
| rotation__UsingRotate.py | UsingRotate | 1/1 | 0/2 | yes | yes |
| specialized__BroadcastExample.py | BroadcastExample | 2/2 | 1/1 | yes | yes |
| speedmodifier__SpeedModifierExample.py | SpeedModifierExample | 4/4 | 0/1 | yes | split chains |
| speedmodifier__SpeedModifierUpdaterExample.py | SpeedModifierUpdaterExample | 3/4 | 0/1 | yes | split chains |
| speedmodifier__SpeedModifierUpdaterExample2.py | SpeedModifierUpdaterExample2 | 4/5 | 0/1 | yes | split chains |
| transform__ClockwiseExample.py | ClockwiseExample | 4/8 | 0/2 | yes | yes |
| transform__MoveToTargetExample.py | MoveToTargetExample | 3/6 | 1/1 | yes | yes |
| transform__WarpSquare.py | WarpSquare | 3/3 | 1/1 | yes | yes |
| transform__FadeToColorExample.py | FadeToColorExample | 1/1 | 0/1 | yes | yes |
| transform__ScaleInPlaceExample.py | ScaleInPlaceExample | 1/1 | 0/1 | yes | yes |
| transform__ShrinkToCenterExample.py | ShrinkToCenterExample | 1/1 | 0/1 | yes | yes |
| transform__RestoreExample.py | RestoreExample | 6/7 | 4/4 | yes | yes |
| transform__ApplyMatrixExample.py | ApplyMatrixExample | 1/2 | 0/2 | yes | yes |
| transform__DifferentFadeTransforms.py | DifferentFadeTransforms | 1/7 | 0/3 | yes | yes |
| transform__FadeTransformSubmobjects.py | FadeTransformSubmobjects | 8/9 | 4/4 | yes | split chains |
| transform_matching_parts__Anagram.py | Anagram | 6/6 | 2/2 | yes | yes |
| mobject_update_utils__TangentAnimation.py | TangentAnimation | 7/7 | 1/1 | yes | keywords |
| mobject_update_utils__ShiftingSquare.py | ShiftingSquare | 4/6 | 1/1 | yes | split chains |
| mobject_update_utils__SpinningTriangle.py | SpinningTriangle | 4/5 | 1/1 | yes | split chains |
| mobject_update_utils__WelcomeToManim.py | WelcomeToManim | 4/7 | 0/0 | yes | split chains |
| constants__LineJointVariants.py | LineJointVariants | 2/6 | 0/0 | yes | yes |
| constants__CapStyleVariants.py | CapStyleVariants | 3/4 | 0/0 | yes | yes |
| arc__ArcExample.py | ArcExample | 0/1 | 0/0 | yes | yes |
| arc__TangentialArcExample.py | TangentialArcExample | 6/6 | 0/0 | yes | keywords |
| arc__TangentialArcCorners.py | TangentialArcCorners | 12/12 | 0/0 | yes | split chains + keywords |
| arc__CircleExample.py | CircleExample | 5/5 | 0/0 | yes | split chains |
| arc__CircleSurround.py | CircleSurround | 11/11 | 0/0 | yes | split chains |
| arc__PointAtAngleExample.py | PointAtAngleExample | 4/6 | 0/0 | yes | split chains |
| arc__CircleFromPointsExample.py | CircleFromPointsExample | 1/3 | 0/0 | yes | yes |
| arc__DotExample.py | DotExample | 4/4 | 0/0 | yes | yes |
| arc__EllipseExample.py | EllipseExample | 4/4 | 0/0 | yes | split chains |
| arc__AnnularSectorExample.py | AnnularSectorExample | 5/6 | 0/0 | yes | split chains |
| arc__ExampleSector.py | ExampleSector | 3/5 | 0/0 | yes | split chains |
| arc__AnnulusExample.py | AnnulusExample | 3/3 | 0/0 | yes | split chains |
| arc__BezierSplineExample.py | BezierSplineExample | 6/10 | 0/0 | yes | split chains + keywords |
| arc__SeveralArcPolygons.py | SeveralArcPolygons | 6/10 | 0/0 | yes | split chains |
| arc__ArcPolygonExample.py | ArcPolygonExample | 2/11 | 0/1 | yes | yes |
| arc__ArcPolygonExample2.py | ArcPolygonExample2 | 3/11 | 0/1 | yes | keywords |
| boolean_ops__UnionExample.py | UnionExample | 7/7 | 0/0 | yes | yes |
| boolean_ops__DifferenceExample.py | DifferenceExample | 7/7 | 0/0 | yes | keywords |
| boolean_ops__IntersectionExample.py | IntersectionExample | 7/7 | 0/0 | yes | yes |
| labeled__LabelExample.py | LabelExample | 3/3 | 0/0 | yes | yes |
| labeled__LabeledPolygramExample.py | LabeledPolygramExample | 8/11 | 0/0 | yes | split chains |
| line__LineExample.py | LineExample | 5/5 | 0/0 | yes | split chains + keywords |
| line__DashedLineExample.py | DashedLineExample | 4/4 | 0/0 | yes | split chains |
| line__TangentLineExample.py | TangentLineExample | 4/4 | 0/0 | yes | yes |
| line__ElbowExample.py | ElbowExample | 5/5 | 0/0 | yes | split chains |
| line__ArrowExample.py | ArrowExample | 10/11 | 0/0 | yes | split chains |
| line__VectorExample.py | VectorExample | 4/4 | 0/0 | yes | yes |
| line__DoubleArrowExample.py | DoubleArrowExample | 5/5 | 0/0 | yes | split chains |
| line__DoubleArrowExample2.py | DoubleArrowExample2 | 5/8 | 0/0 | yes | yes |
| line__RightArcAngleExample.py | RightArcAngleExample | 4/7 | 0/0 | yes | keywords |
| line__AngleExample.py | AngleExample | 4/7 | 0/0 | yes | keywords |
| line__FilledAngle.py | FilledAngle | 7/12 | 0/0 | yes | split chains + keywords |
| line__AngleFromThreePointsExample.py | AngleFromThreePointsExample | 1/3 | 0/0 | yes | yes |
| line__RightAngleExample.py | RightAngleExample | 4/7 | 0/0 | yes | keywords |
| polygram__PolygramExample.py | PolygramExample | 6/6 | 1/1 | yes | yes |
| polygram__PolygramRoundCorners.py | PolygramRoundCorners | 6/6 | 0/0 | yes | split chains |
| polygram__PolygonExample.py | PolygonExample | 3/4 | 0/0 | yes | yes |
| polygram__RegularPolygramExample.py | RegularPolygramExample | 2/2 | 0/0 | yes | yes |
| polygram__RegularPolygonExample.py | RegularPolygonExample | 5/5 | 0/0 | yes | split chains |
| polygram__StarExample.py | StarExample | 5/5 | 2/2 | yes | yes |
| polygram__DifferentDensitiesExample.py | DifferentDensitiesExample | 2/3 | 0/0 | yes | yes |
| polygram__TriangleExample.py | TriangleExample | 4/4 | 0/0 | yes | split chains |
| polygram__RectangleExample.py | RectangleExample | 5/6 | 0/0 | yes | split chains |
| polygram__SquareExample.py | SquareExample | 4/4 | 0/0 | yes | split chains |
| polygram__RoundedRectangleExample.py | RoundedRectangleExample | 4/4 | 0/0 | yes | split chains |
| polygram__CutoutExample.py | CutoutExample | 8/8 | 1/1 | yes | split chains |
| polygram__ConvexHullExample.py | ConvexHullExample | 4/5 | 0/0 | yes | yes |
| shape_matchers__ExampleBackgroundRectangle.py | ExampleBackgroundRectangle | 12/12 | 2/2 | yes | split chains |
| shape_matchers__ExampleCross.py | ExampleCross | 2/2 | 0/0 | yes | yes |
| tips__ArrowTipsShowcase.py | ArrowTipsShowcase | 0/5 | 0/0 | yes | yes |
| graph__ImportNetworkxGraph.py | ImportNetworkxGraph | 2/4 | 0/2 | yes | yes |
| graph__ChangeGraphLayout.py | ChangeGraphLayout | 4/4 | 2/2 | yes | keywords |
| graph__MovingVertices.py | MovingVertices | 6/8 | 1/10 | yes | keywords |
| graph__GraphAutoPosition.py | GraphAutoPosition | 3/8 | 0/0 | yes | split chains |
| graph__GraphManualPosition.py | GraphManualPosition | 2/5 | 0/0 | yes | keywords |
| graph__PartiteGraph.py | PartiteGraph | 2/5 | 1/1 | yes | keywords |
| graph__LinearNN.py | LinearNN | 2/9 | 0/0 | yes | keywords |
| graph__Tree.py | Tree | 1/4 | 0/1 | yes | yes |
| graph__MovingDiGraph.py | MovingDiGraph | 4/6 | 0/4 | yes | keywords |
| coordinate_systems__PolarToPointExample.py | PolarToPointExample | 4/4 | 0/0 | yes | yes |
| coordinate_systems__GetLinesToPointExample.py | GetLinesToPointExample | 5/5 | 0/0 | yes | split chains + keywords |
| coordinate_systems__PlotExample.py | PlotExample | 9/13 | 0/0 | yes | keywords |
| coordinate_systems__ImplicitExample.py | ImplicitExample | 3/3 | 0/0 | yes | keywords |
| coordinate_systems__ParametricCurveExample.py | ParametricCurveExample | 3/3 | 0/0 | yes | keywords |
| coordinate_systems__PolarGraphExample.py | PolarGraphExample | 3/4 | 0/0 | yes | keywords |
| coordinate_systems__PlotSurfaceExample.py | PlotSurfaceExample | 4/6 | 0/0 | yes | keywords |
| coordinate_systems__InputToGraphPointExample.py | InputToGraphPointExample | 4/5 | 0/0 | yes | split chains + keywords |
| coordinate_systems__GetRiemannRectanglesExample.py | GetRiemannRectanglesExample | 7/7 | 0/0 | yes | keywords |
| coordinate_systems__AntiderivativeExample.py | AntiderivativeExample | 4/4 | 0/0 | yes | keywords |
| coordinate_systems__AxesWithDifferentTips.py | AxesWithDifferentTips | 2/2 | 0/0 | yes | yes |
| coordinate_systems__NumberPlaneExample.py | NumberPlaneExample | 2/2 | 0/0 | yes | yes |
| coordinate_systems__NumberPlaneScaled.py | NumberPlaneScaled | 4/4 | 0/0 | yes | split chains |
| functions__PlotParametricFunction.py | PlotParametricFunction | 1/2 | 0/0 | yes | split chains |
| functions__ThreeDParametricSpring.py | ThreeDParametricSpring | 5/5 | 0/0 | yes | split chains |
| functions__DiscontinuousExample.py | DiscontinuousExample | 5/7 | 0/0 | yes | keywords |
| functions__ExampleFunctionGraph.py | ExampleFunctionGraph | 4/4 | 0/0 | yes | split chains |
| functions__ImplicitFunctionExample.py | ImplicitFunctionExample | 1/2 | 0/0 | yes | yes |
| probability__ExampleSampleSpace.py | ExampleSampleSpace | 5/6 | 0/0 | yes | split chains |
| logo__DarkThemeBanner.py | DarkThemeBanner | 3/5 | 1/1 | yes | yes |
| logo__LightThemeBanner.py | LightThemeBanner | 3/6 | 1/1 | yes | yes |
| logo__ExpandDirections.py | ExpandDirections | 0/2 | 0/0 | yes | yes |
| mobject__ChangedDefaultTextcolor.py | ChangedDefaultTextcolor | 0/3 | 0/0 | yes | yes |
| mobject__AnimateExample.py | AnimateExample | 6/6 | 5/5 | yes | yes |
| mobject__AnimateChainExample.py | AnimateChainExample | 4/4 | 3/3 | yes | yes |
| mobject__AnimateWithArgsExample.py | AnimateWithArgsExample | 4/5 | 2/2 | yes | yes |
| mobject__AlwaysExample.py | AlwaysExample | 4/5 | 1/1 | yes | split chains |
| mobject__DtUpdater.py | DtUpdater | 3/4 | 0/0 | yes | yes |
| mobject__MobjectScaleExample.py | MobjectScaleExample | 6/6 | 0/0 | yes | split chains |
| mobject__RotateMethodExample.py | RotateMethodExample | 6/11 | 0/0 | yes | yes |
| mobject__FlipExample.py | FlipExample | 4/4 | 0/0 | yes | split chains + keywords |
| mobject__ApplyFuncExample.py | ApplyFuncExample | 6/8 | 2/2 | yes | split chains |
| mobject__GeometricShapes.py | GeometricShapes | 5/8 | 0/0 | yes | yes |
| mobject__AngleMidPoint.py | AngleMidPoint | 6/6 | 0/0 | yes | split chains + keywords |
| mobject__Example.py | Example | 6/6 | 0/0 | yes | split chains |
| mobject__ExampleBoxes.py | ExampleBoxes | 3/3 | 0/0 | yes | yes |
| mobject__ArrangeInGrid.py | ArrangeInGrid | 2/3 | 0/0 | yes | yes |
| mobject__InvertSumobjectsExample.py | InvertSumobjectsExample | 3/5 | 2/2 | yes | yes |
| mobject__ArrangeSumobjectsExample.py | ArrangeSumobjectsExample | 4/6 | 0/0 | yes | split chains |
| mobject__ShuffleSubmobjectsExample.py | ShuffleSubmobjectsExample | 3/5 | 2/2 | yes | yes |
| mobject__InterpolateExample.py | InterpolateExample | 6/16 | 0/0 | yes | split chains + keywords |
| mobject__BecomeScene.py | BecomeScene | 5/6 | 0/0 | yes | yes |
| mobject__MatchPointsScene.py | MatchPointsScene | 6/6 | 1/1 | yes | yes |
| mobject__AnimationOverrideExample.py | AnimationOverrideExample | 5/5 | 2/2 | yes | yes |
| opengl_mobject__ChangedDefaultTextcolor.py | ChangedDefaultTextcolor | 0/3 | 0/0 | yes | yes |
| opengl_mobject__AnimateExample.py | AnimateExample | 6/6 | 5/5 | yes | yes |
| opengl_mobject__AnimateChainExample.py | AnimateChainExample | 4/4 | 3/3 | yes | yes |
| opengl_mobject__AnimateWithArgsExample.py | AnimateWithArgsExample | 4/5 | 2/2 | yes | yes |
| opengl_mobject__AngleMidPoint.py | AngleMidPoint | 6/6 | 0/0 | yes | split chains + keywords |
| opengl_mobject__MatchPointsScene.py | MatchPointsScene | 6/6 | 1/1 | yes | yes |
| opengl_mobject__ExampleBoxes.py | ExampleBoxes | 3/3 | 0/0 | yes | yes |
| opengl_mobject__ArrangeInGrid.py | ArrangeInGrid | 2/4 | 0/0 | yes | yes |
| opengl_mobject__InvertSumobjectsExample.py | InvertSumobjectsExample | 3/5 | 2/2 | yes | yes |
| opengl_mobject__MobjectScaleExample.py | MobjectScaleExample | 6/6 | 0/0 | yes | split chains |
| opengl_mobject__FlipExample.py | FlipExample | 4/4 | 0/0 | yes | split chains + keywords |
| opengl_mobject__ApplyFuncExample.py | ApplyFuncExample | 6/8 | 2/2 | yes | split chains |
| opengl_mobject__GeometricShapes.py | GeometricShapes | 5/8 | 0/0 | yes | yes |
| opengl_mobject__BecomeScene.py | BecomeScene | 5/6 | 0/0 | yes | yes |
| opengl_mobject__AnimationOverrideExample.py | AnimationOverrideExample | 5/5 | 2/2 | yes | yes |
| opengl_vectorized_mobject__SetFill.py | SetFill | 7/7 | 0/0 | yes | split chains |
| opengl_vectorized_mobject__ChangeOfDirection.py | ChangeOfDirection | 5/5 | 2/2 | yes | yes |
| opengl_vectorized_mobject__LineGradientExample.py | LineGradientExample | 3/4 | 0/0 | yes | yes |
| brace__BraceExample.py | BraceExample | 2/4 | 0/0 | yes | yes |
| brace__BraceTextExample.py | BraceTextExample | 10/10 | 0/0 | yes | split chains + keywords |
| brace__BraceBPExample.py | BraceBPExample | 4/6 | 1/2 | yes | keywords |
| brace__ArcBraceExample.py | ArcBraceExample | 13/14 | 0/0 | yes | split chains + keywords |
| table__BackgroundRectanglesExample.py | BackgroundRectanglesExample | 8/8 | 0/0 | yes | split chains |
| table__GetHorizontalLinesExample.py | GetHorizontalLinesExample | 2/3 | 0/0 | yes | yes |
| table__GetVerticalLinesExample.py | GetVerticalLinesExample | 2/3 | 0/0 | yes | yes |
| table__GetColumnsExample.py | GetColumnsExample | 3/3 | 0/0 | yes | yes |
| table__GetRowsExample.py | GetRowsExample | 3/3 | 0/0 | yes | yes |
| table__SetColumnColorsExample.py | SetColumnColorsExample | 2/2 | 0/0 | yes | split chains |
| table__SetRowColorsExample.py | SetRowColorsExample | 2/2 | 0/0 | yes | split chains |
| table__GetEntriesExample.py | GetEntriesExample | 3/5 | 0/0 | yes | yes |
| table__GetEntriesWithoutLabelsExample.py | GetEntriesWithoutLabelsExample | 3/6 | 0/0 | yes | yes |
| table__GetRowLabelsExample.py | GetRowLabelsExample | 3/4 | 0/0 | yes | yes |
| table__GetColLabelsExample.py | GetColLabelsExample | 3/4 | 0/0 | yes | yes |
| table__GetLabelsExample.py | GetLabelsExample | 3/5 | 0/0 | yes | yes |
| table__GetCellExample.py | GetCellExample | 3/3 | 0/0 | yes | keywords |
| table__GetHighlightedCellExample.py | GetHighlightedCellExample | 3/4 | 0/0 | yes | keywords |
| table__AddHighlightedCellExample.py | AddHighlightedCellExample | 3/3 | 0/0 | yes | yes |
| table__CreateTableExample.py | CreateTableExample | 2/3 | 0/0 | yes | yes |
| table__MobjectTableExample.py | MobjectTableExample | 6/6 | 0/0 | yes | split chains + keywords |
| text_mobject__HelloWorld.py | HelloWorld | 2/2 | 0/0 | yes | split chains |
| text_mobject__TextAlignment.py | TextAlignment | 9/11 | 0/0 | yes | split chains |
| text_mobject__Example1Text.py | Example1Text | 2/2 | 0/0 | yes | split chains |
| text_mobject__TextColorExample.py | TextColorExample | 3/3 | 0/0 | yes | split chains |
| text_mobject__TextItalicAndBoldExample.py | TextItalicAndBoldExample | 8/9 | 0/0 | yes | yes |
| text_mobject__TextMoreCustomization.py | TextMoreCustomization | 2/2 | 0/0 | yes | split chains |
| text_mobject__MultipleFonts.py | MultipleFonts | 8/9 | 0/0 | yes | yes |
| text_mobject__PangoRender.py | PangoRender | 3/3 | 1/1 | yes | yes |
| text_mobject__MarkupExample.py | MarkupExample | 2/2 | 0/0 | yes | yes |
| text_mobject__MarkupElaborateExample.py | MarkupElaborateExample | 2/2 | 0/0 | yes | yes |
| text_mobject__BasicMarkupExample.py | BasicMarkupExample | 7/7 | 0/0 | yes | split chains |
| text_mobject__ColorExample.py | ColorExample | 9/9 | 0/0 | yes | split chains |
| text_mobject__UnderlineExample.py | UnderlineExample | 7/7 | 0/0 | yes | split chains |
| text_mobject__FontExample.py | FontExample | 6/6 | 0/0 | yes | split chains |
| text_mobject__NewlineExample.py | NewlineExample | 2/2 | 0/0 | yes | yes |
| text_mobject__NoLigaturesExample.py | NoLigaturesExample | 4/4 | 0/0 | yes | split chains |
| text_mobject__MultiLanguage.py | MultiLanguage | 8/8 | 0/0 | yes | split chains |
| polyhedra__SquarePyramidScene.py | SquarePyramidScene | 3/5 | 0/0 | yes | keywords |
| polyhedra__PolyhedronSubMobjects.py | PolyhedronSubMobjects | 3/5 | 0/0 | yes | yes |
| polyhedra__TetrahedronScene.py | TetrahedronScene | 3/3 | 0/0 | yes | yes |
| polyhedra__OctahedronScene.py | OctahedronScene | 3/3 | 0/0 | yes | yes |
| polyhedra__IcosahedronScene.py | IcosahedronScene | 3/3 | 0/0 | yes | yes |
| polyhedra__DodecahedronScene.py | DodecahedronScene | 3/3 | 0/0 | yes | yes |
| polyhedra__ConvexHull3DExample.py | ConvexHull3DExample | 5/6 | 0/0 | yes | yes |
| three_dimensions__ParaSurface.py | ParaSurface | 4/4 | 0/0 | yes | yes |
| three_dimensions__FillByValueExample.py | FillByValueExample | 6/8 | 0/0 | yes | split chains |
| three_dimensions__ExampleSphere.py | ExampleSphere | 10/10 | 0/0 | yes | yes |
| three_dimensions__ExampleSphereOverlap.py | ExampleSphereOverlap | 10/10 | 0/0 | yes | yes |
| three_dimensions__ExamplePartialSpheres.py | ExamplePartialSpheres | 10/10 | 0/0 | yes | yes |
| three_dimensions__Dot3DExample.py | Dot3DExample | 6/6 | 0/0 | yes | yes |
| three_dimensions__CubeExample.py | CubeExample | 4/4 | 0/0 | yes | yes |
| three_dimensions__ExamplePrism.py | ExamplePrism | 4/4 | 0/0 | yes | split chains |
| three_dimensions__ExampleCone.py | ExampleCone | 4/4 | 0/0 | yes | yes |
| three_dimensions__ExampleCylinder.py | ExampleCylinder | 4/4 | 0/0 | yes | yes |
| three_dimensions__ExampleLine3D.py | ExampleLine3D | 4/4 | 0/0 | yes | yes |
| three_dimensions__ParallelLineExample.py | ParallelLineExample | 4/5 | 0/0 | yes | keywords |
| three_dimensions__PerpLineExample.py | PerpLineExample | 4/5 | 0/0 | yes | keywords |
| three_dimensions__ExampleArrow3D.py | ExampleArrow3D | 4/4 | 0/0 | yes | yes |
| image_mobject__ImageFromArray.py | ImageFromArray | 2/3 | 0/0 | yes | yes |
| image_mobject__ImageInterpolationEx.py | ImageInterpolationEx | 3/7 | 0/0 | yes | yes |
| point_cloud_mobject__PMobjectExample.py | PMobjectExample | 2/4 | 0/0 | yes | yes |
| point_cloud_mobject__PgroupExample.py | PgroupExample | 7/7 | 0/0 | yes | yes |
| point_cloud_mobject__PointCloudDotExample.py | PointCloudDotExample | 5/5 | 0/0 | yes | split chains |
| point_cloud_mobject__PointCloudDotExample2.py | PointCloudDotExample2 | 5/5 | 1/1 | yes | yes |
| point_cloud_mobject__ExamplePoint.py | ExamplePoint | 1/4 | 0/0 | yes | yes |
| vectorized_mobject__SetFill.py | SetFill | 7/7 | 0/0 | yes | split chains |
| vectorized_mobject__CapStyleExample.py | CapStyleExample | 3/3 | 0/0 | yes | keywords |
| vectorized_mobject__MobjectScaleExample.py | MobjectScaleExample | 6/6 | 2/2 | yes | split chains + keywords |
| vectorized_mobject__SetSheen.py | SetSheen | 2/2 | 0/0 | yes | split chains |
| vectorized_mobject__PointsAsCornersExample.py | PointsAsCornersExample | 2/4 | 0/0 | yes | yes |
| vectorized_mobject__PointFromProportion.py | PointFromProportion | 2/5 | 0/0 | yes | keywords |
| vectorized_mobject__ChangeOfDirection.py | ChangeOfDirection | 5/5 | 2/2 | yes | yes |
| vectorized_mobject__ArcShapeIris.py | ArcShapeIris | 2/5 | 0/0 | yes | yes |
| vectorized_mobject__AddToVGroup.py | AddToVGroup | 11/15 | 3/5 | yes | yes |
| vectorized_mobject__AddIterableToVGroupExample.py | AddIterableToVGroupExample | 3/3 | 0/0 | yes | yes |
| vectorized_mobject__LineGradientExample.py | LineGradientExample | 3/4 | 0/0 | yes | yes |
| vectorized_mobject__DashedVMobjectExample.py | DashedVMobjectExample | 8/14 | 0/0 | yes | split chains + keywords |
| value_tracker__ComplexValueTrackerExample.py | ComplexValueTrackerExample | 6/7 | 4/4 | yes | split chains |
| vector_field__ScaleVectorFieldFunction.py | ScaleVectorFieldFunction | 5/7 | 1/1 | yes | yes |
| vector_field__Nudging.py | Nudging | 6/12 | 0/0 | yes | split chains |
| vector_field__BasicUsage.py | BasicUsage | 0/2 | 0/0 | yes | yes |
| vector_field__SizingAndSpacing.py | SizingAndSpacing | 6/8 | 1/1 | yes | yes |
| vector_field__Coloring.py | Coloring | 4/6 | 0/0 | yes | split chains |
| vector_field__StreamLineCreation.py | StreamLineCreation | 2/4 | 0/0 | yes | yes |
| vector_field__ContinuousMotion.py | ContinuousMotion | 3/5 | 0/0 | yes | yes |
| vector_field__EndAnimation.py | EndAnimation | 3/6 | 0/0 | yes | yes |
| moving_camera_scene__ChangingCameraWidthAndRestore.py | ChangingCameraWidthAndRestore | 5/6 | 0/2 | yes | split chains |
| moving_camera_scene__MovingCameraCenter.py | MovingCameraCenter | 7/7 | 0/2 | yes | split chains |
| moving_camera_scene__MovingAndZoomingCamera.py | MovingAndZoomingCamera | 7/7 | 0/3 | yes | split chains |
| moving_camera_scene__MovingCameraOnGraph.py | MovingCameraOnGraph | 9/10 | 0/3 | yes | keywords |
| zoomed_scene__UseZoomedScene.py | UseZoomedScene | 6/6 | 1/1 | yes | split chains |
| zoomed_scene__ChangingZoomScale.py | ChangingZoomScale | 9/9 | 1/3 | yes | split chains |
| manim_colors__ColorsOverview.py | ColorsOverview | 1/12 | 0/0 | yes | yes |
| manim_directive__MyScene.py | MyScene | 0/1 | 0/0 | yes | yes |
| rate_functions__RateFuncExample.py | RateFuncExample | 2/7 | 0/0 | yes | yes |
| odd_plus_odd.py | OddPlusOdd | 72/78 | 28/40 | yes | split chains |
| odd_times_odd.py | OddTimesOdd | 68/72 | 25/32 | yes | split chains |
| helpers_and_state.py | Walkthrough | 9/13 | 2/5 | yes | split chains |
| lesson_two_scenes.py | Intro | 11/12 | 2/8 | yes | yes |
| lesson_two_scenes.py | Outro | 7/7 | 3/4 | yes | yes |
| transitions.py | Morphs | 14/15 | 9/10 | yes | split chains |
