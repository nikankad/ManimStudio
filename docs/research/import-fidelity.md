# Import fidelity

How much of real manim code becomes an editable scene, measured by `scripts/import_fidelity.py` (manim 0.22.0, 15 fps, 192×108). Scenes manim itself can't render here (OpenGL only, missing asset files, missing packages) are skipped and left out of the numbers; scenes that only need LaTeX (not installed here) count in everything but the comparisons with manim.

Reading the numbers: a statement kept as a code step still runs exactly as written (the parity rows), but the editor can't show or change what it does: its objects aren't in the scene's object list, its animations have no keyframe rows. So the share of statements on the timeline is how much of a project is editable, and parity is how much of it is safe.

## Project-shaped files (scripts/fidelity_corpus)

| | |
|---|---|
| Scenes | 7 (1 skipped: manim can't render them here; 1 more need LaTeX, so they count below except in the rows that compare with manim) |
| Imported | 6 of 6 |
| construct() statements on the timeline (not code steps) | **100%** (87 of 87) |
| Scenes with no code steps at all | 100% (6 of 6) |
| Animations whose target is one of the scene's objects (keyframe rows) | 52% (23 of 44) |
| Regenerated code: same length and plays as the original under manim | 100% (5 of 5; 0 failed to run) |
| Regenerated code: same frame at the end of every play and wait, pixel for pixel | 100% (5 of 5; 5 of these scenes show something) |
| Editor preview: same length as manim | 100% (5 of 5) |
| Regenerated construct() is the same Python (AST) | 100% (6 of 6; the others: none) |

## This repository's examples/

| | |
|---|---|
| Scenes | 2 (0 skipped: manim can't render them here; 0 more need LaTeX, so they count below except in the rows that compare with manim) |
| Imported | 2 of 2 |
| construct() statements on the timeline (not code steps) | **100%** (150 of 150) |
| Scenes with no code steps at all | 100% (2 of 2) |
| Animations whose target is one of the scene's objects (keyframe rows) | 74% (53 of 72) |
| Regenerated code: same length and plays as the original under manim | 100% (2 of 2; 0 failed to run) |
| Regenerated code: same frame at the end of every play and wait, pixel for pixel | 100% (2 of 2; 2 of these scenes show something) |
| Editor preview: same length as manim | 100% (2 of 2) |
| Regenerated construct() is the same Python (AST) | 100% (2 of 2; the others: none) |

## manim's documentation examples

| | |
|---|---|
| Scenes | 383 (19 skipped: manim can't render them here; 100 more need LaTeX, so they count below except in the rows that compare with manim) |
| Imported | 364 of 364 |
| construct() statements on the timeline (not code steps) | **99%** (2081 of 2102) |
| Scenes with no code steps at all | 96% (350 of 364) |
| Animations whose target is one of the scene's objects (keyframe rows) | 60% (160 of 268) |
| Regenerated code: same length and plays as the original under manim | 100% (263 of 263; 1 failed to run) |
| Regenerated code: same frame at the end of every play and wait, pixel for pixel | 100% (263 of 263; 259 of these scenes show something) |
| Editor preview: same length as manim | 100% (263 of 264) |
| Regenerated construct() is the same Python (AST) | 100% (363 of 364; the others: 1 unreadable) |

Files with several scenes (lesson_two_scenes.py) open one scene per project; the other scenes stay in the regenerated file as written.

## Keyframes (all imported scenes)

| Channel | Keyframes | Value set directly in Effect Controls |
|---|---|---|
| position | 60 | 42% (25) |
| scale | 10 | 100% (10) |
| rotation | 13 | 100% (13) |
| opacity | 1 | 100% (1) |
| color | 7 | 86% (6) |
| value | 13 | 69% (9) |

Every keyframe can be edited in Effect Controls; the others are edited by their method's arguments, as code (relative ones can also be pinned to a point), because:

- 10× .next_to(…) places it relative to something else
- 9× The value is an expression (…)
- 7× .to_edge(…) places it relative to something else
- 6× .align_to(…) places it relative to something else
- 4× .to_corner(…) places it relative to something else
- 3× Measuring where it starts…
- 1× .set_fill(…) here doesn't set a colour

## Timeline steps (all imported scenes)

357× add, 317× play, 214× assign, 177× apply, 128× wait, 49× block, 45× end, 28× call, 21× code, 2× remove

## What the importer keeps as code

Statements of construct() kept as code steps, by kind:

- 10× function definition
- 4× Expr
- 3× self.play(…) with computed arguments
- 2× Import
- 1× ImportFrom
- 1× method call on an expression (VGroup(...).arrange(), group[0].shift()…)

The importer's own notes:

- 3× Line …: this self.play is kept as code (its animations are built by an expression, such as a list or a variable).

## Animation classes on the timeline

animate 105, Write 44, Create 32, FadeIn 32, expr 22, FadeOut 19, Indicate 9, LaggedStartMap 9, Uncreate 7, Rotate 6, Circumscribe 6, MoveAlongPath 6, Wiggle 6, Transform 5, FadeTransform 5, Unwrite 4, ReplacementTransform 4, Rotating 4, Blink 3, Flash 3, ApplyWave 3, ChangeSpeed 3, Restore 3, Wait 2, Add 2, DrawBorderThenFill 2, GrowFromCenter 2, ShowPassingFlash 2, ApplyMatrix 2, TransformMatchingShapes 2

## Skipped (manim can't render them here)

- 9× ImportError: TypstMobject requires the … Python package. Install it with:  pip install typst>=0.14
- 8× NameError: name … is not defined
- 1× ModuleNotFoundError: No module named …
- 1× OSError: From: /home/user/ManimStudio/.claude/worktrees/ux-workflow, could not find click.wav at eit
- 1× crashed (FileNotFoundError)

## Failures

- `rate_functions__RateFuncExample.py` RateFuncExample: regenerated: SyntaxError: expected ':' (<scene>, line 8)

## Per scene

| File | Scene | Statements on timeline | Anims on objects | Regenerated = original | Same AST |
|---|---|---|---|---|---|
| animation__LagRatios.py | LagRatios | 9/9 | 0/2 | yes | yes |
| animation__ChangeDefaultAnimation.py | ChangeDefaultAnimation | 8/8 | 2/2 | yes | yes |
| animation__DefaultAddScene.py | DefaultAddScene | 7/7 | 2/5 | yes | yes |
| animation__AddWithRunTimeScene.py | AddWithRunTimeScene | 3/3 | 0/1 | yes | yes |
| animation__OverrideAnimationExample.py | OverrideAnimationExample | 1/1 | 0/1 | yes | yes |
| changing__AnimatedBoundaryExample.py | AnimatedBoundaryExample | 4/4 | 0/0 | yes | yes |
| changing__TracedPathExample.py | TracedPathExample | 7/7 | 1/1 | yes | yes |
| changing__DissipatingPathExample.py | DissipatingPathExample | 6/6 | 2/2 | yes | yes |
| composition__SuccessionExample.py | SuccessionExample | 6/6 | 4/4 | yes | yes |
| composition__LaggedStartExample.py | LaggedStartExample | 8/8 | 3/3 | yes | yes |
| composition__LaggedStartMapExample.py | LaggedStartMapExample | 5/5 | 0/1 | needs LaTeX | yes |
| creation__CreateScene.py | CreateScene | 1/1 | 0/1 | yes | yes |
| creation__ShowUncreate.py | ShowUncreate | 1/1 | 0/1 | yes | yes |
| creation__ShowDrawBorderThenFill.py | ShowDrawBorderThenFill | 1/1 | 0/1 | yes | yes |
| creation__ShowWrite.py | ShowWrite | 1/1 | 0/1 | yes | yes |
| creation__ShowWriteReversed.py | ShowWriteReversed | 1/1 | 0/1 | yes | yes |
| creation__UnwriteReverseFalse.py | UnwriteReverseFalse | 3/3 | 1/1 | needs LaTeX | yes |
| creation__ShowIncreasingSubsetsScene.py | ShowIncreasingSubsetsScene | 4/4 | 1/1 | yes | yes |
| creation__InsertingTextExample.py | InsertingTextExample | 4/4 | 2/2 | yes | yes |
| creation__DeletingTextExample.py | DeletingTextExample | 4/4 | 2/2 | yes | yes |
| fading__Fading.py | Fading | 5/5 | 3/3 | needs LaTeX | yes |
| growing__Growing.py | Growing | 12/12 | 5/5 | yes | yes |
| indication__Indications.py | Indications | 10/10 | 0/5 | needs LaTeX | yes |
| indication__UsingFocusOn.py | UsingFocusOn | 4/4 | 1/1 | needs LaTeX | yes |
| indication__UsingIndicate.py | UsingIndicate | 3/3 | 1/1 | needs LaTeX | yes |
| indication__UsingFlash.py | UsingFlash | 4/4 | 1/1 | needs LaTeX | yes |
| indication__FlashOnCircle.py | FlashOnCircle | 4/4 | 1/1 | yes | yes |
| indication__TimeWidthValues.py | TimeWidthValues | 7/7 | 0/1 | needs LaTeX | yes |
| indication__ApplyingWaves.py | ApplyingWaves | 4/4 | 3/3 | needs LaTeX | yes |
| indication__UsingCircumscribe.py | UsingCircumscribe | 7/7 | 5/5 | needs LaTeX | yes |
| indication__BlinkingExample.py | BlinkingExample | 3/3 | 1/1 | yes | yes |
| movement__HomotopyExample.py | HomotopyExample | 2/3 | 1/1 | yes | yes |
| movement__MoveAlongPathExample.py | MoveAlongPathExample | 6/6 | 1/1 | yes | yes |
| numbers__ChangingDecimalExample.py | ChangingDecimalExample | 4/4 | 1/1 | needs LaTeX | yes |
| numbers__ChangeDecimalToValueExample.py | ChangeDecimalToValueExample | 4/4 | 1/1 | needs LaTeX | yes |
| rotation__RotatingDemo.py | RotatingDemo | 12/12 | 4/6 | yes | yes |
| rotation__RotatingDifferentAxis.py | RotatingDifferentAxis | 8/11 | 0/0 | yes | yes |
| rotation__UsingRotate.py | UsingRotate | 1/1 | 0/2 | yes | yes |
| specialized__BroadcastExample.py | BroadcastExample | 2/2 | 1/1 | yes | yes |
| speedmodifier__SpeedModifierExample.py | SpeedModifierExample | 4/4 | 0/1 | yes | yes |
| speedmodifier__SpeedModifierUpdaterExample.py | SpeedModifierUpdaterExample | 4/4 | 0/1 | yes | yes |
| speedmodifier__SpeedModifierUpdaterExample2.py | SpeedModifierUpdaterExample2 | 5/5 | 0/1 | yes | yes |
| transform__ReplacementTransformOrTransform.py | ReplacementTransformOrTransform | 17/17 | 0/4 | needs LaTeX | yes |
| transform__ClockwiseExample.py | ClockwiseExample | 8/8 | 0/2 | yes | yes |
| transform__CounterclockwiseTransform_vs_Transform.py | CounterclockwiseTransform_vs_Transform | 14/14 | 0/2 | needs LaTeX | yes |
| transform__MoveToTargetExample.py | MoveToTargetExample | 6/6 | 1/1 | yes | yes |
| transform__WarpSquare.py | WarpSquare | 3/3 | 1/1 | yes | yes |
| transform__FadeToColorExample.py | FadeToColorExample | 1/1 | 0/1 | yes | yes |
| transform__ScaleInPlaceExample.py | ScaleInPlaceExample | 1/1 | 0/1 | yes | yes |
| transform__ShrinkToCenterExample.py | ShrinkToCenterExample | 1/1 | 0/1 | yes | yes |
| transform__RestoreExample.py | RestoreExample | 7/7 | 4/4 | yes | yes |
| transform__ApplyMatrixExample.py | ApplyMatrixExample | 2/2 | 0/2 | yes | yes |
| transform__DifferentFadeTransforms.py | DifferentFadeTransforms | 7/7 | 0/5 | yes | yes |
| transform__FadeTransformSubmobjects.py | FadeTransformSubmobjects | 9/9 | 4/5 | yes | yes |
| transform_matching_parts__Anagram.py | Anagram | 6/6 | 2/2 | yes | yes |
| transform_matching_parts__MatchingEquationParts.py | MatchingEquationParts | 10/10 | 1/2 | needs LaTeX | yes |
| mobject_update_utils__TangentAnimation.py | TangentAnimation | 7/7 | 1/1 | yes | yes |
| mobject_update_utils__ShiftingSquare.py | ShiftingSquare | 5/6 | 1/1 | yes | yes |
| mobject_update_utils__SpinningTriangle.py | SpinningTriangle | 4/5 | 1/1 | yes | yes |
| mobject_update_utils__WelcomeToManim.py | WelcomeToManim | 6/7 | 0/1 | yes | yes |
| constants__LineJointVariants.py | LineJointVariants | 9/9 | 0/0 | yes | yes |
| constants__CapStyleVariants.py | CapStyleVariants | 6/6 | 0/0 | yes | yes |
| arc__UsefulAnnotations.py | UsefulAnnotations | 10/10 | 0/0 | needs LaTeX | yes |
| arc__ArcExample.py | ArcExample | 1/1 | 0/0 | yes | yes |
| arc__ArcBetweenPointsExample.py | ArcBetweenPointsExample | 8/8 | 1/1 | needs LaTeX | yes |
| arc__TangentialArcExample.py | TangentialArcExample | 6/6 | 0/0 | yes | yes |
| arc__TangentialArcCorners.py | TangentialArcCorners | 12/12 | 0/0 | yes | yes |
| arc__CircleExample.py | CircleExample | 5/5 | 0/0 | yes | yes |
| arc__CircleSurround.py | CircleSurround | 11/11 | 0/0 | yes | yes |
| arc__PointAtAngleExample.py | PointAtAngleExample | 6/6 | 0/0 | yes | yes |
| arc__CircleFromPointsExample.py | CircleFromPointsExample | 3/3 | 0/0 | yes | yes |
| arc__DotExample.py | DotExample | 4/4 | 0/0 | yes | yes |
| arc__SeveralLabeledDots.py | SeveralLabeledDots | 11/11 | 0/0 | needs LaTeX | yes |
| arc__EllipseExample.py | EllipseExample | 4/4 | 0/0 | yes | yes |
| arc__AnnularSectorExample.py | AnnularSectorExample | 6/6 | 0/0 | yes | yes |
| arc__ExampleSector.py | ExampleSector | 5/5 | 0/0 | yes | yes |
| arc__AnnulusExample.py | AnnulusExample | 3/3 | 0/0 | yes | yes |
| arc__BezierSplineExample.py | BezierSplineExample | 10/10 | 0/0 | yes | yes |
| arc__SeveralArcPolygons.py | SeveralArcPolygons | 10/10 | 0/1 | yes | yes |
| arc__ArcPolygonExample.py | ArcPolygonExample | 11/11 | 0/1 | yes | yes |
| arc__ArcPolygonExample2.py | ArcPolygonExample2 | 11/11 | 0/1 | yes | yes |
| boolean_ops__UnionExample.py | UnionExample | 7/7 | 0/0 | yes | yes |
| boolean_ops__DifferenceExample.py | DifferenceExample | 7/7 | 0/0 | yes | yes |
| boolean_ops__IntersectionExample.py | IntersectionExample | 7/7 | 0/0 | yes | yes |
| labeled__LabelExample.py | LabelExample | 3/3 | 0/0 | yes | yes |
| labeled__LabeledLineExample.py | LabeledLineExample | 3/3 | 0/0 | needs LaTeX | yes |
| labeled__LabeledArrowExample.py | LabeledArrowExample | 2/2 | 0/0 | needs LaTeX | yes |
| labeled__LabeledPolygramExample.py | LabeledPolygramExample | 11/11 | 0/0 | yes | yes |
| line__LineExample.py | LineExample | 5/5 | 0/0 | yes | yes |
| line__DashedLineExample.py | DashedLineExample | 4/4 | 0/0 | yes | yes |
| line__TangentLineExample.py | TangentLineExample | 4/4 | 0/0 | yes | yes |
| line__ElbowExample.py | ElbowExample | 5/5 | 0/0 | yes | yes |
| line__ArrowExample.py | ArrowExample | 11/11 | 0/0 | yes | yes |
| line__VectorExample.py | VectorExample | 4/4 | 0/0 | yes | yes |
| line__VectorCoordinateLabel.py | VectorCoordinateLabel | 6/6 | 0/0 | needs LaTeX | yes |
| line__DoubleArrowExample.py | DoubleArrowExample | 5/5 | 0/0 | yes | yes |
| line__DoubleArrowExample2.py | DoubleArrowExample2 | 8/8 | 0/0 | yes | yes |
| line__RightArcAngleExample.py | RightArcAngleExample | 9/9 | 0/0 | yes | yes |
| line__AngleExample.py | AngleExample | 9/9 | 0/0 | yes | yes |
| line__FilledAngle.py | FilledAngle | 12/12 | 0/0 | yes | yes |
| line__GetValueExample.py | GetValueExample | 6/6 | 0/0 | needs LaTeX | yes |
| line__AngleFromThreePointsExample.py | AngleFromThreePointsExample | 3/3 | 0/0 | yes | yes |
| line__RightAngleExample.py | RightAngleExample | 9/9 | 0/0 | yes | yes |
| polygram__PolygramExample.py | PolygramExample | 6/6 | 1/1 | yes | yes |
| polygram__PolygramRoundCorners.py | PolygramRoundCorners | 6/6 | 0/0 | yes | yes |
| polygram__PolygonExample.py | PolygonExample | 4/4 | 0/0 | yes | yes |
| polygram__RegularPolygramExample.py | RegularPolygramExample | 2/2 | 0/0 | yes | yes |
| polygram__RegularPolygonExample.py | RegularPolygonExample | 5/5 | 0/0 | yes | yes |
| polygram__StarExample.py | StarExample | 5/5 | 2/2 | yes | yes |
| polygram__DifferentDensitiesExample.py | DifferentDensitiesExample | 3/3 | 0/0 | yes | yes |
| polygram__TriangleExample.py | TriangleExample | 4/4 | 0/0 | yes | yes |
| polygram__RectangleExample.py | RectangleExample | 6/6 | 0/0 | yes | yes |
| polygram__SquareExample.py | SquareExample | 4/4 | 0/0 | yes | yes |
| polygram__RoundedRectangleExample.py | RoundedRectangleExample | 4/4 | 0/0 | yes | yes |
| polygram__CutoutExample.py | CutoutExample | 8/8 | 1/1 | yes | yes |
| polygram__ConvexHullExample.py | ConvexHullExample | 5/5 | 0/0 | yes | yes |
| shape_matchers__SurroundingRectExample.py | SurroundingRectExample | 7/7 | 0/0 | needs LaTeX | yes |
| shape_matchers__ExampleBackgroundRectangle.py | ExampleBackgroundRectangle | 12/12 | 2/2 | yes | yes |
| shape_matchers__ExampleCross.py | ExampleCross | 2/2 | 0/0 | yes | yes |
| shape_matchers__UnderLine.py | UnderLine | 3/3 | 0/0 | needs LaTeX | yes |
| tips__ArrowTipsShowcase.py | ArrowTipsShowcase | 5/5 | 0/0 | yes | yes |
| graph__CustomLayoutExample.py | CustomLayoutExample | 3/6 | 0/0 | needs LaTeX | yes |
| graph__CircularLayout.py | CircularLayout | 2/2 | 0/0 | needs LaTeX | yes |
| graph__KamadaKawaiLayout.py | KamadaKawaiLayout | 9/10 | 0/0 | needs LaTeX | yes |
| graph__PartiteLayout.py | PartiteLayout | 2/2 | 0/0 | needs LaTeX | yes |
| graph__PlanarLayout.py | PlanarLayout | 2/2 | 0/0 | needs LaTeX | yes |
| graph__RandomLayout.py | RandomLayout | 2/2 | 0/0 | needs LaTeX | yes |
| graph__ShellLayout.py | ShellLayout | 3/3 | 0/0 | needs LaTeX | yes |
| graph__SpectralLayout.py | SpectralLayout | 2/2 | 0/0 | needs LaTeX | yes |
| graph__SpiralLayout.py | SpiralLayout | 2/2 | 0/0 | needs LaTeX | yes |
| graph__SpringLayout.py | SpringLayout | 2/2 | 0/0 | needs LaTeX | yes |
| graph__TreeLayout.py | TreeLayout | 2/2 | 0/0 | needs LaTeX | yes |
| graph__ImportNetworkxGraph.py | ImportNetworkxGraph | 4/4 | 0/3 | yes | yes |
| graph__ChangeGraphLayout.py | ChangeGraphLayout | 4/4 | 2/2 | yes | yes |
| graph__MovingVertices.py | MovingVertices | 8/8 | 1/10 | yes | yes |
| graph__GraphAutoPosition.py | GraphAutoPosition | 8/8 | 0/0 | yes | yes |
| graph__GraphManualPosition.py | GraphManualPosition | 5/5 | 0/0 | yes | yes |
| graph__LabeledModifiedGraph.py | LabeledModifiedGraph | 4/4 | 0/0 | needs LaTeX | yes |
| graph__PartiteGraph.py | PartiteGraph | 5/5 | 1/1 | yes | yes |
| graph__LinearNN.py | LinearNN | 15/15 | 0/0 | yes | yes |
| graph__Tree.py | Tree | 10/10 | 0/1 | yes | yes |
| graph__MovingDiGraph.py | MovingDiGraph | 6/6 | 0/4 | yes | yes |
| graph__CustomDiGraph.py | CustomDiGraph | 6/6 | 1/1 | needs LaTeX | yes |
| graph__UndirectedMovingDiGraph.py | UndirectedMovingDiGraph | 8/8 | 1/5 | needs LaTeX | yes |
| coordinate_systems__CoordSysExample.py | CoordSysExample | 14/14 | 0/0 | needs LaTeX | yes |
| coordinate_systems__PolarToPointExample.py | PolarToPointExample | 4/4 | 0/0 | yes | yes |
| coordinate_systems__GetXAxisLabelExample.py | GetXAxisLabelExample | 3/3 | 0/0 | needs LaTeX | yes |
| coordinate_systems__GetYAxisLabelExample.py | GetYAxisLabelExample | 3/3 | 0/0 | needs LaTeX | yes |
| coordinate_systems__GetVerticalLineExample.py | GetVerticalLineExample | 5/5 | 0/0 | needs LaTeX | yes |
| coordinate_systems__GetHorizontalLineExample.py | GetHorizontalLineExample | 5/5 | 0/0 | needs LaTeX | yes |
| coordinate_systems__GetLinesToPointExample.py | GetLinesToPointExample | 5/5 | 0/0 | yes | yes |
| coordinate_systems__PlotExample.py | PlotExample | 12/13 | 0/0 | yes | yes |
| coordinate_systems__ImplicitExample.py | ImplicitExample | 3/3 | 0/0 | yes | yes |
| coordinate_systems__ParametricCurveExample.py | ParametricCurveExample | 3/3 | 0/0 | yes | yes |
| coordinate_systems__PolarGraphExample.py | PolarGraphExample | 4/4 | 0/0 | yes | yes |
| coordinate_systems__PlotSurfaceExample.py | PlotSurfaceExample | 5/6 | 0/0 | yes | yes |
| coordinate_systems__InputToGraphPointExample.py | InputToGraphPointExample | 5/5 | 0/0 | yes | yes |
| coordinate_systems__GetGraphLabelExample.py | GetGraphLabelExample | 4/4 | 0/0 | needs LaTeX | yes |
| coordinate_systems__GetRiemannRectanglesExample.py | GetRiemannRectanglesExample | 7/7 | 0/0 | yes | yes |
| coordinate_systems__GetAreaExample.py | GetAreaExample | 4/4 | 0/0 | needs LaTeX | yes |
| coordinate_systems__DerivativeGraphExample.py | DerivativeGraphExample | 8/8 | 0/0 | needs LaTeX | yes |
| coordinate_systems__AntiderivativeExample.py | AntiderivativeExample | 4/4 | 0/0 | yes | yes |
| coordinate_systems__GetSecantSlopeGroupExample.py | GetSecantSlopeGroupExample | 4/4 | 0/0 | needs LaTeX | yes |
| coordinate_systems__GetVerticalLinesToGraph.py | GetVerticalLinesToGraph | 4/4 | 0/0 | needs LaTeX | yes |
| coordinate_systems__TLabelExample.py | TLabelExample | 4/4 | 0/0 | needs LaTeX | yes |
| coordinate_systems__LogScalingExample.py | LogScalingExample | 3/3 | 0/0 | needs LaTeX | yes |
| coordinate_systems__AxesWithDifferentTips.py | AxesWithDifferentTips | 2/2 | 0/0 | yes | yes |
| coordinate_systems__CoordsToPointExample.py | CoordsToPointExample | 6/6 | 0/0 | needs LaTeX | yes |
| coordinate_systems__PointToCoordsExample.py | PointToCoordsExample | 5/5 | 0/0 | needs LaTeX | yes |
| coordinate_systems__GetAxisLabelsExample.py | GetAxisLabelsExample | 3/3 | 0/0 | needs LaTeX | yes |
| coordinate_systems__LineGraphExample.py | LineGraphExample | 4/4 | 0/0 | needs LaTeX | yes |
| coordinate_systems__GetZAxisLabelExample.py | GetZAxisLabelExample | 4/4 | 0/0 | needs LaTeX | yes |
| coordinate_systems__NumberPlaneExample.py | NumberPlaneExample | 2/2 | 0/0 | yes | yes |
| coordinate_systems__NumberPlaneScaled.py | NumberPlaneScaled | 4/4 | 0/0 | yes | yes |
| coordinate_systems__PolarPlaneExample.py | PolarPlaneExample | 2/2 | 0/0 | needs LaTeX | yes |
| coordinate_systems__ComplexPlaneExample.py | ComplexPlaneExample | 7/7 | 0/0 | needs LaTeX | yes |
| functions__PlotParametricFunction.py | PlotParametricFunction | 2/2 | 0/0 | yes | yes |
| functions__ThreeDParametricSpring.py | ThreeDParametricSpring | 5/5 | 0/0 | yes | yes |
| functions__DiscontinuousExample.py | DiscontinuousExample | 7/7 | 0/0 | yes | yes |
| functions__ExampleFunctionGraph.py | ExampleFunctionGraph | 4/4 | 0/0 | yes | yes |
| functions__ImplicitFunctionExample.py | ImplicitFunctionExample | 2/2 | 0/0 | yes | yes |
| number_line__NumberLineExample.py | NumberLineExample | 8/8 | 0/0 | needs LaTeX | yes |
| probability__ExampleSampleSpace.py | ExampleSampleSpace | 6/6 | 0/0 | yes | yes |
| probability__BarChartExample.py | BarChartExample | 3/3 | 0/0 | needs LaTeX | yes |
| probability__GetBarLabelsExample.py | GetBarLabelsExample | 3/3 | 0/0 | needs LaTeX | yes |
| probability__ChangeBarValuesExample.py | ChangeBarValuesExample | 5/5 | 0/0 | needs LaTeX | yes |
| logo__DarkThemeBanner.py | DarkThemeBanner | 5/5 | 1/3 | yes | yes |
| logo__LightThemeBanner.py | LightThemeBanner | 6/6 | 1/3 | yes | yes |
| logo__ExpandDirections.py | ExpandDirections | 2/2 | 0/3 | yes | yes |
| matrix__MatrixExamples.py | MatrixExamples | 6/6 | 0/0 | needs LaTeX | yes |
| matrix__BackgroundRectanglesExample.py | BackgroundRectanglesExample | 9/9 | 0/0 | needs LaTeX | yes |
| matrix__GetColumnsExample.py | GetColumnsExample | 3/3 | 0/0 | needs LaTeX | yes |
| matrix__SetColumnColorsExample.py | SetColumnColorsExample | 2/2 | 0/0 | needs LaTeX | yes |
| matrix__GetRowsExample.py | GetRowsExample | 3/3 | 0/0 | needs LaTeX | yes |
| matrix__SetRowColorsExample.py | SetRowColorsExample | 2/2 | 0/0 | needs LaTeX | yes |
| matrix__GetEntriesExample.py | GetEntriesExample | 6/6 | 0/0 | needs LaTeX | yes |
| matrix__GetBracketsExample.py | GetBracketsExample | 6/6 | 0/0 | needs LaTeX | yes |
| matrix__DecimalMatrixExample.py | DecimalMatrixExample | 2/2 | 0/0 | needs LaTeX | yes |
| matrix__IntegerMatrixExample.py | IntegerMatrixExample | 2/2 | 0/0 | needs LaTeX | yes |
| matrix__MobjectMatrixExample.py | MobjectMatrixExample | 6/6 | 0/0 | needs LaTeX | yes |
| matrix__DeterminantOfAMatrix.py | DeterminantOfAMatrix | 4/4 | 0/0 | needs LaTeX | yes |
| mobject__ChangedDefaultTextcolor.py | ChangedDefaultTextcolor | 3/3 | 0/0 | yes | yes |
| mobject__AnimateExample.py | AnimateExample | 6/6 | 5/5 | yes | yes |
| mobject__AnimateChainExample.py | AnimateChainExample | 4/4 | 3/3 | yes | yes |
| mobject__AnimateWithArgsExample.py | AnimateWithArgsExample | 5/5 | 2/2 | yes | yes |
| mobject__AlwaysExample.py | AlwaysExample | 5/5 | 1/1 | yes | yes |
| mobject__WidthExample.py | WidthExample | 7/7 | 1/1 | needs LaTeX | yes |
| mobject__HeightExample.py | HeightExample | 7/7 | 1/1 | needs LaTeX | yes |
| mobject__NextToUpdater.py | NextToUpdater | 5/6 | 1/1 | needs LaTeX | yes |
| mobject__DtUpdater.py | DtUpdater | 4/4 | 0/0 | yes | yes |
| mobject__MobjectScaleExample.py | MobjectScaleExample | 6/6 | 0/0 | yes | yes |
| mobject__RotateMethodExample.py | RotateMethodExample | 11/11 | 0/0 | yes | yes |
| mobject__FlipExample.py | FlipExample | 4/4 | 0/0 | yes | yes |
| mobject__ApplyFuncExample.py | ApplyFuncExample | 8/8 | 2/2 | yes | yes |
| mobject__ToCornerExample.py | ToCornerExample | 7/7 | 0/0 | needs LaTeX | yes |
| mobject__ToEdgeExample.py | ToEdgeExample | 7/7 | 0/0 | needs LaTeX | yes |
| mobject__GeometricShapes.py | GeometricShapes | 8/8 | 0/0 | yes | yes |
| mobject__AngleMidPoint.py | AngleMidPoint | 6/6 | 0/0 | yes | yes |
| mobject__Example.py | Example | 6/6 | 0/0 | yes | yes |
| mobject__ExampleBoxes.py | ExampleBoxes | 3/3 | 0/0 | yes | yes |
| mobject__ArrangeInGrid.py | ArrangeInGrid | 3/3 | 0/0 | yes | yes |
| mobject__InvertSumobjectsExample.py | InvertSumobjectsExample | 5/5 | 2/2 | yes | yes |
| mobject__ArrangeSumobjectsExample.py | ArrangeSumobjectsExample | 6/6 | 0/0 | yes | yes |
| mobject__ShuffleSubmobjectsExample.py | ShuffleSubmobjectsExample | 5/5 | 2/2 | yes | yes |
| mobject__InterpolateExample.py | InterpolateExample | 16/16 | 0/0 | yes | yes |
| mobject__BecomeScene.py | BecomeScene | 6/6 | 0/0 | yes | yes |
| mobject__MatchPointsScene.py | MatchPointsScene | 6/6 | 1/1 | yes | yes |
| mobject__SetZIndex.py | SetZIndex | 8/8 | 0/0 | needs LaTeX | yes |
| mobject__AnimationOverrideExample.py | AnimationOverrideExample | 5/5 | 2/2 | yes | yes |
| opengl_mobject__ChangedDefaultTextcolor.py | ChangedDefaultTextcolor | 3/3 | 0/0 | yes | yes |
| opengl_mobject__AnimateExample.py | AnimateExample | 6/6 | 5/5 | yes | yes |
| opengl_mobject__AnimateChainExample.py | AnimateChainExample | 4/4 | 3/3 | yes | yes |
| opengl_mobject__AnimateWithArgsExample.py | AnimateWithArgsExample | 5/5 | 2/2 | yes | yes |
| opengl_mobject__WidthExample.py | WidthExample | 7/7 | 1/1 | needs LaTeX | yes |
| opengl_mobject__HeightExample.py | HeightExample | 7/7 | 1/1 | needs LaTeX | yes |
| opengl_mobject__AngleMidPoint.py | AngleMidPoint | 6/6 | 0/0 | yes | yes |
| opengl_mobject__MatchPointsScene.py | MatchPointsScene | 6/6 | 1/1 | yes | yes |
| opengl_mobject__ExampleBoxes.py | ExampleBoxes | 3/3 | 0/0 | yes | yes |
| opengl_mobject__ArrangeInGrid.py | ArrangeInGrid | 4/4 | 0/0 | yes | yes |
| opengl_mobject__InvertSumobjectsExample.py | InvertSumobjectsExample | 5/5 | 2/2 | yes | yes |
| opengl_mobject__MobjectScaleExample.py | MobjectScaleExample | 6/6 | 0/0 | yes | yes |
| opengl_mobject__FlipExample.py | FlipExample | 4/4 | 0/0 | yes | yes |
| opengl_mobject__ApplyFuncExample.py | ApplyFuncExample | 8/8 | 2/2 | yes | yes |
| opengl_mobject__GeometricShapes.py | GeometricShapes | 8/8 | 0/0 | yes | yes |
| opengl_mobject__BecomeScene.py | BecomeScene | 6/6 | 0/0 | yes | yes |
| opengl_mobject__AnimationOverrideExample.py | AnimationOverrideExample | 5/5 | 2/2 | yes | yes |
| opengl_vectorized_mobject__SetFill.py | SetFill | 7/7 | 0/0 | yes | yes |
| opengl_vectorized_mobject__ChangeOfDirection.py | ChangeOfDirection | 5/5 | 2/2 | yes | yes |
| opengl_vectorized_mobject__LineGradientExample.py | LineGradientExample | 4/4 | 0/0 | yes | yes |
| brace__BraceExample.py | BraceExample | 8/8 | 0/0 | yes | yes |
| brace__BraceTextExample.py | BraceTextExample | 10/10 | 0/0 | yes | yes |
| brace__BraceBPExample.py | BraceBPExample | 6/6 | 1/2 | yes | yes |
| brace__ArcBraceExample.py | ArcBraceExample | 14/14 | 0/0 | yes | yes |
| table__TableExamples.py | TableExamples | 20/20 | 0/0 | needs LaTeX | yes |
| table__BackgroundRectanglesExample.py | BackgroundRectanglesExample | 8/8 | 0/0 | yes | yes |
| table__GetHorizontalLinesExample.py | GetHorizontalLinesExample | 3/3 | 0/0 | yes | yes |
| table__GetVerticalLinesExample.py | GetVerticalLinesExample | 3/3 | 0/0 | yes | yes |
| table__GetColumnsExample.py | GetColumnsExample | 3/3 | 0/0 | yes | yes |
| table__GetRowsExample.py | GetRowsExample | 3/3 | 0/0 | yes | yes |
| table__SetColumnColorsExample.py | SetColumnColorsExample | 2/2 | 0/0 | yes | yes |
| table__SetRowColorsExample.py | SetRowColorsExample | 2/2 | 0/0 | yes | yes |
| table__GetEntriesExample.py | GetEntriesExample | 6/6 | 0/0 | yes | yes |
| table__GetEntriesWithoutLabelsExample.py | GetEntriesWithoutLabelsExample | 7/7 | 0/0 | yes | yes |
| table__GetRowLabelsExample.py | GetRowLabelsExample | 5/5 | 0/0 | yes | yes |
| table__GetColLabelsExample.py | GetColLabelsExample | 5/5 | 0/0 | yes | yes |
| table__GetLabelsExample.py | GetLabelsExample | 6/6 | 0/0 | yes | yes |
| table__GetCellExample.py | GetCellExample | 3/3 | 0/0 | yes | yes |
| table__GetHighlightedCellExample.py | GetHighlightedCellExample | 4/4 | 0/0 | yes | yes |
| table__AddHighlightedCellExample.py | AddHighlightedCellExample | 3/3 | 0/0 | yes | yes |
| table__CreateTableExample.py | CreateTableExample | 3/3 | 0/1 | yes | yes |
| table__MathTableExample.py | MathTableExample | 2/2 | 0/0 | needs LaTeX | yes |
| table__MobjectTableExample.py | MobjectTableExample | 6/6 | 0/0 | yes | yes |
| table__IntegerTableExample.py | IntegerTableExample | 2/2 | 0/0 | needs LaTeX | yes |
| table__DecimalTableExample.py | DecimalTableExample | 4/4 | 0/0 | needs LaTeX | yes |
| numbers__MovingSquareWithUpdaters.py | MovingSquareWithUpdaters | 7/7 | 1/1 | needs LaTeX | yes |
| numbers__IntegerExample.py | IntegerExample | 4/4 | 0/0 | needs LaTeX | yes |
| numbers__VariablesWithValueTracker.py | VariablesWithValueTracker | 24/24 | 3/5 | needs LaTeX | yes |
| numbers__VariableExample.py | VariableExample | 8/8 | 0/1 | needs LaTeX | yes |
| tex_mobject__Formula.py | Formula | 2/2 | 0/0 | needs LaTeX | yes |
| tex_mobject__BulletedListExample.py | BulletedListExample | 5/5 | 0/0 | needs LaTeX | yes |
| tex_mobject__TitleExample.py | TitleExample | 3/3 | 0/0 | needs LaTeX | yes |
| text_mobject__HelloWorld.py | HelloWorld | 2/2 | 0/0 | yes | yes |
| text_mobject__TextAlignment.py | TextAlignment | 11/11 | 0/0 | yes | yes |
| text_mobject__Example1Text.py | Example1Text | 2/2 | 0/0 | yes | yes |
| text_mobject__TextColorExample.py | TextColorExample | 3/3 | 0/0 | yes | yes |
| text_mobject__TextItalicAndBoldExample.py | TextItalicAndBoldExample | 9/9 | 0/0 | yes | yes |
| text_mobject__TextMoreCustomization.py | TextMoreCustomization | 2/2 | 0/0 | yes | yes |
| text_mobject__MultipleFonts.py | MultipleFonts | 10/10 | 0/0 | yes | yes |
| text_mobject__PangoRender.py | PangoRender | 3/3 | 1/1 | yes | yes |
| text_mobject__MarkupExample.py | MarkupExample | 2/2 | 0/0 | yes | yes |
| text_mobject__MarkupElaborateExample.py | MarkupElaborateExample | 2/2 | 0/0 | yes | yes |
| text_mobject__BasicMarkupExample.py | BasicMarkupExample | 7/7 | 0/0 | yes | yes |
| text_mobject__ColorExample.py | ColorExample | 9/9 | 0/0 | yes | yes |
| text_mobject__UnderlineExample.py | UnderlineExample | 7/7 | 0/0 | yes | yes |
| text_mobject__FontExample.py | FontExample | 6/6 | 0/0 | yes | yes |
| text_mobject__NewlineExample.py | NewlineExample | 2/2 | 0/0 | yes | yes |
| text_mobject__NoLigaturesExample.py | NoLigaturesExample | 4/4 | 0/0 | yes | yes |
| text_mobject__MultiLanguage.py | MultiLanguage | 8/8 | 0/0 | yes | yes |
| text_mobject__JustifyText.py | JustifyText | 8/8 | 4/4 | needs LaTeX | yes |
| polyhedra__SquarePyramidScene.py | SquarePyramidScene | 5/5 | 0/0 | yes | yes |
| polyhedra__PolyhedronSubMobjects.py | PolyhedronSubMobjects | 5/5 | 0/0 | yes | yes |
| polyhedra__TetrahedronScene.py | TetrahedronScene | 3/3 | 0/0 | yes | yes |
| polyhedra__OctahedronScene.py | OctahedronScene | 3/3 | 0/0 | yes | yes |
| polyhedra__IcosahedronScene.py | IcosahedronScene | 3/3 | 0/0 | yes | yes |
| polyhedra__DodecahedronScene.py | DodecahedronScene | 3/3 | 0/0 | yes | yes |
| polyhedra__ConvexHull3DExample.py | ConvexHull3DExample | 6/6 | 0/0 | yes | yes |
| three_dimensions__ParaSurface.py | ParaSurface | 4/4 | 0/0 | yes | yes |
| three_dimensions__FillByValueExample.py | FillByValueExample | 7/8 | 0/0 | yes | yes |
| three_dimensions__ExampleSphere.py | ExampleSphere | 10/10 | 0/0 | yes | yes |
| three_dimensions__ExampleSphereOverlap.py | ExampleSphereOverlap | 10/10 | 0/0 | yes | yes |
| three_dimensions__ExamplePartialSpheres.py | ExamplePartialSpheres | 10/10 | 0/0 | yes | yes |
| three_dimensions__Dot3DExample.py | Dot3DExample | 6/6 | 0/0 | yes | yes |
| three_dimensions__CubeExample.py | CubeExample | 4/4 | 0/0 | yes | yes |
| three_dimensions__ExamplePrism.py | ExamplePrism | 4/4 | 0/0 | yes | yes |
| three_dimensions__ExampleCone.py | ExampleCone | 4/4 | 0/0 | yes | yes |
| three_dimensions__ExampleCylinder.py | ExampleCylinder | 4/4 | 0/0 | yes | yes |
| three_dimensions__ExampleLine3D.py | ExampleLine3D | 4/4 | 0/0 | yes | yes |
| three_dimensions__ParallelLineExample.py | ParallelLineExample | 5/5 | 0/0 | yes | yes |
| three_dimensions__PerpLineExample.py | PerpLineExample | 5/5 | 0/0 | yes | yes |
| three_dimensions__ExampleArrow3D.py | ExampleArrow3D | 4/4 | 0/0 | yes | yes |
| image_mobject__ImageFromArray.py | ImageFromArray | 3/3 | 0/0 | yes | yes |
| image_mobject__ImageInterpolationEx.py | ImageInterpolationEx | 11/11 | 0/0 | yes | yes |
| point_cloud_mobject__PMobjectExample.py | PMobjectExample | 6/6 | 0/0 | yes | yes |
| point_cloud_mobject__PgroupExample.py | PgroupExample | 7/7 | 0/0 | yes | yes |
| point_cloud_mobject__PointCloudDotExample.py | PointCloudDotExample | 5/5 | 0/0 | yes | yes |
| point_cloud_mobject__PointCloudDotExample2.py | PointCloudDotExample2 | 5/5 | 1/1 | yes | yes |
| point_cloud_mobject__ExamplePoint.py | ExamplePoint | 8/8 | 0/0 | yes | yes |
| vectorized_mobject__SetFill.py | SetFill | 7/7 | 0/0 | yes | yes |
| vectorized_mobject__CapStyleExample.py | CapStyleExample | 3/3 | 0/0 | yes | yes |
| vectorized_mobject__MobjectScaleExample.py | MobjectScaleExample | 6/6 | 2/2 | yes | yes |
| vectorized_mobject__SetSheen.py | SetSheen | 2/2 | 0/0 | yes | yes |
| vectorized_mobject__PointsAsCornersExample.py | PointsAsCornersExample | 4/4 | 0/0 | yes | yes |
| vectorized_mobject__PointFromProportion.py | PointFromProportion | 6/6 | 0/0 | yes | yes |
| vectorized_mobject__ChangeOfDirection.py | ChangeOfDirection | 5/5 | 2/2 | yes | yes |
| vectorized_mobject__ArcShapeIris.py | ArcShapeIris | 5/5 | 0/0 | yes | yes |
| vectorized_mobject__AddToVGroup.py | AddToVGroup | 15/15 | 3/5 | yes | yes |
| vectorized_mobject__AddIterableToVGroupExample.py | AddIterableToVGroupExample | 3/3 | 0/0 | yes | yes |
| vectorized_mobject__ShapesWithVDict.py | ShapesWithVDict | 32/32 | 3/7 | needs LaTeX | yes |
| vectorized_mobject__LineGradientExample.py | LineGradientExample | 4/4 | 0/0 | yes | yes |
| vectorized_mobject__DashedVMobjectExample.py | DashedVMobjectExample | 18/18 | 0/0 | yes | yes |
| value_tracker__ValueTrackerExample.py | ValueTrackerExample | 15/15 | 3/3 | needs LaTeX | yes |
| value_tracker__ComplexValueTrackerExample.py | ComplexValueTrackerExample | 7/7 | 4/4 | yes | yes |
| vector_field__ScaleVectorFieldFunction.py | ScaleVectorFieldFunction | 7/7 | 1/1 | yes | yes |
| vector_field__Nudging.py | Nudging | 12/12 | 0/0 | yes | yes |
| vector_field__BasicUsage.py | BasicUsage | 2/2 | 0/0 | yes | yes |
| vector_field__SizingAndSpacing.py | SizingAndSpacing | 8/8 | 1/1 | yes | yes |
| vector_field__Coloring.py | Coloring | 6/6 | 0/0 | yes | yes |
| vector_field__SpawningAndFlowingArea.py | SpawningAndFlowingArea | 8/8 | 0/0 | needs LaTeX | yes |
| vector_field__StreamLineCreation.py | StreamLineCreation | 4/4 | 0/1 | yes | yes |
| vector_field__ContinuousMotion.py | ContinuousMotion | 5/5 | 0/0 | yes | yes |
| vector_field__EndAnimation.py | EndAnimation | 6/6 | 0/1 | yes | yes |
| moving_camera_scene__ChangingCameraWidthAndRestore.py | ChangingCameraWidthAndRestore | 6/6 | 0/2 | yes | yes |
| moving_camera_scene__MovingCameraCenter.py | MovingCameraCenter | 7/7 | 0/2 | yes | yes |
| moving_camera_scene__MovingAndZoomingCamera.py | MovingAndZoomingCamera | 7/7 | 0/3 | yes | yes |
| moving_camera_scene__MovingCameraOnGraph.py | MovingCameraOnGraph | 10/10 | 0/3 | yes | yes |
| moving_camera_scene__SlidingMultipleFrames.py | SlidingMultipleFrames | 6/8 | 0/2 | needs LaTeX | yes |
| vector_space_scene__LinearTransformationSceneExample.py | LinearTransformationSceneExample | 3/3 | 0/0 | needs LaTeX | yes |
| zoomed_scene__UseZoomedScene.py | UseZoomedScene | 6/6 | 1/1 | yes | yes |
| zoomed_scene__ChangingZoomScale.py | ChangingZoomScale | 9/9 | 1/3 | yes | yes |
| manim_colors__ColorsOverview.py | ColorsOverview | 10/13 | 0/0 | yes | yes |
| debug__IndexLabelsExample.py | IndexLabelsExample | 5/5 | 0/0 | needs LaTeX | yes |
| manim_directive__MyScene.py | MyScene | 0/1 | 0/0 | yes | yes |
| rate_functions__RateFuncExample.py | RateFuncExample | 16/16 | 0/0 | error | unreadable |
| rate_functions__RateFunctions1Example.py | RateFunctions1Example | 12/12 | 3/6 | needs LaTeX | yes |
| odd_plus_odd.py | OddPlusOdd | 78/78 | 28/40 | yes | yes |
| odd_times_odd.py | OddTimesOdd | 72/72 | 25/32 | yes | yes |
| bubble_sort.py | BubbleSort | 25/25 | 2/9 | yes | yes |
| custom_mobject.py | GaugeScene | 14/14 | 4/6 | needs LaTeX | yes |
| helpers_and_state.py | Walkthrough | 14/14 | 3/6 | yes | yes |
| lesson_two_scenes.py | Intro | 12/12 | 2/8 | yes | yes |
| lesson_two_scenes.py | Outro | 7/7 | 3/4 | yes | yes |
| transitions.py | Morphs | 15/15 | 9/11 | yes | yes |
