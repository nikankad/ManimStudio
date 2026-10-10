"""Source of the ``TimedAnimations`` helper emitted into generated scenes.

manim plays animations in sequence (``self.play`` calls). A non-linear
timeline lets clips start at any time and overlap arbitrarily, so overlapping
clips are compiled into one ``self.play(TimedAnimations(...))`` whose children
are *constructed lazily at their start time*. That keeps manim's semantics
intact: ``x.animate.shift(UP)`` starts from wherever ``x`` is at that moment,
and an object only appears on screen when its intro animation begins.

The helper is plain manim code, so exported ``.py`` files stay standalone.
"""

SOURCE = '''
class TimedAnimations(Animation):
    """Run animations at explicit start times (seconds) inside one self.play().

    Each clip is (start, factory). The factory is called when the clip starts and
    returns an Animation / .animate builder; anything else is an instant action
    (e.g. ``lambda: self.add(dot)``).
    """

    def __init__(self, *clips, **kwargs):
        from manim.animation.animation import prepare_animation

        self._prepare = prepare_animation
        self._clips = sorted(clips, key=lambda c: c[0])
        self._next = 0
        self._active = []
        self._scene = None
        kwargs.setdefault("rate_func", linear)
        super().__init__(Mobject(), **kwargs)

    def _setup_scene(self, scene):
        # Children add mobjects as they start, so make the renderer treat every
        # mobject as moving (placing ours first does exactly that).
        self._scene = scene
        if self.mobject in scene.mobjects:
            scene.mobjects.remove(self.mobject)
        scene.mobjects.insert(0, self.mobject)

    def begin(self):
        self._advance(0.0)

    def _interpolate_active(self, t):
        for start, anim in self._active:
            anim.interpolate(min(1.0, max(0.0, (t - start) / anim.run_time)))

    def _advance(self, t):
        eps = 1e-9
        while True:
            next_start = self._clips[self._next][0] if self._next < len(self._clips) else float("inf")
            next_end = min((s + a.run_time for s, a in self._active), default=float("inf"))
            event = min(next_start, next_end)
            if event > t + eps:
                break
            self._interpolate_active(event)
            if next_end <= next_start:  # finish before starting on ties
                for item in [x for x in self._active if x[0] + x[1].run_time <= event + eps]:
                    self._active.remove(item)
                    item[1].finish()
                    item[1].clean_up_from_scene(self._scene)
            else:
                start, factory = self._clips[self._next]
                self._next += 1
                made = factory()
                if isinstance(made, Animation) or hasattr(made, "build"):  # else: instant action
                    anim = self._prepare(made)
                    anim._setup_scene(self._scene)
                    # Like Scene.play: anything animated that isn't on screen yet gets added.
                    if not anim.is_introducer() and anim.mobject not in self._scene.get_mobject_family_members():
                        self._scene.add(anim.mobject)
                    anim.begin()
                    self._active.append((start, anim))
        self._interpolate_active(t)

    def interpolate(self, alpha):
        self._advance(alpha * self.run_time)
        if self._scene is not None:
            self._scene.moving_mobjects = [*self._scene.mobjects, *self._scene.foreground_mobjects]

    def update_mobjects(self, dt):
        for _, anim in self._active:
            anim.update_mobjects(dt)

    def finish(self):
        self._advance(self.run_time)
        for start, anim in self._active:
            anim.finish()
            anim.clean_up_from_scene(self._scene)
        self._active = []

    def clean_up_from_scene(self, scene):
        scene.remove(self.mobject)
'''
