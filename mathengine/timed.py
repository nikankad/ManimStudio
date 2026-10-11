"""Source of the ``TimedAnimations`` helper emitted into generated scenes.

manim plays animations in sequence (``self.play`` calls). A non-linear
timeline lets clips start at any time and overlap arbitrarily, so overlapping
clips are compiled into one ``self.play(TimedAnimations(...))`` whose children
are *constructed lazily at their start time*. That keeps manim's semantics
intact: ``x.animate.shift(UP)`` starts from wherever ``x`` is at that moment,
and an object only appears on screen when its intro animation begins.

Clips on different tracks may animate the same object at overlapping times. In
plain manim the animation that starts later takes the object over and the
earlier one stops moving it. Here their effects add up instead: while they
overlap, each runs on a private copy, and the object is its state when the
overlap began plus every animation's change since then. A move and a color
change, two moves, a rotation or a fade-out while moving all compose as on a
video timeline. Animations that replace the object, change its structure (a
Transform into another shape) or set a ValueTracker keep manim's behavior: the
later one wins.

The helper is plain manim code, so exported ``.py`` files stay standalone.
"""

SOURCE = '''
class _Layer:
    """Overlapping animations of one mobject, each on a private copy; their changes add up (TimedAnimations)."""

    FIELDS = ("points", "fill_rgbas", "stroke_rgbas", "background_stroke_rgbas", "stroke_width",
              "background_stroke_width", "rgbas")

    def __init__(self, target):
        self.target = target
        self.base = target.copy()  # its state when the overlap began, plus the changes of finished members
        self.members = []  # [animation, private copy, the copy's state when it joined]
        self.resume = False  # the target's updating was suspended by a member that was moved to a copy

    def join(self, anim, private):
        self.members.append([anim, private, private.copy()])

    @staticmethod
    def _sum(base, deltas):
        shape = np.broadcast_shapes(np.shape(base), *(np.shape(x) for pair in deltas for x in pair))
        out = np.array(np.broadcast_to(base, shape), dtype=float)
        for now, then in deltas:
            out += np.broadcast_to(now, shape) - np.broadcast_to(then, shape)
        return out

    def _combined(self, into, members):
        """New values of every field of ``into``'s family: its own plus the members' changes."""
        fams = [into.get_family()] + [f for _, p, r in members for f in (p.get_family(), r.get_family())]
        if len({len(f) for f in fams}) != 1:
            raise ValueError("the structure changed")
        out = []
        for i, mob in enumerate(fams[0]):
            for name in self.FIELDS:
                if hasattr(mob, name):
                    pairs = [(getattr(fams[1 + 2 * k][i], name), getattr(fams[2 + 2 * k][i], name)) for k in range(len(members))]
                    out.append((mob, name, self._sum(getattr(mob, name), pairs)))
        return out

    @staticmethod
    def _write(updates, family):
        for (mob, name, value), dest in zip(updates, family):
            if name.endswith("rgbas"):
                value = np.clip(value, 0, 1)
            elif name.endswith("width") and np.ndim(value) == 0:
                value = float(value)
            setattr(dest, name, value)

    def apply(self):
        """Set the target to the base plus every member's change so far."""
        try:
            updates = self._combined(self.base, self.members)
        except ValueError:  # e.g. a member was aligned to another shape: the newest one wins, as in manim
            self.target.become(self.members[-1][1])
            return
        target = {id(m): t for m, t in zip(self.base.get_family(), self.target.get_family())}
        self._write(updates, [target[id(m)] for m, _, _ in updates])

    def bake(self, member):
        """Fold a finished member's change into the base."""
        try:
            updates = self._combined(self.base, [member])
        except ValueError:
            return
        self._write(updates, [m for m, _, _ in updates])


class TimedAnimations(Animation):
    """Run animations at explicit start times (seconds) inside one self.play().

    Each clip is (start, factory). The factory is called when the clip starts and
    returns an Animation / .animate builder; anything else is an instant action
    (e.g. ``lambda: self.add(dot)``). Animations of the same mobject that overlap
    in time add up (see _Layer).
    """

    def __init__(self, *clips, **kwargs):
        from manim.animation.animation import prepare_animation

        self._prepare = prepare_animation
        self._clips = sorted(clips, key=lambda c: c[0])
        self._next = 0
        self._active = []
        self._layers = {}  # id(mobject) -> _Layer
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

    @staticmethod
    def _layerable(anim):
        return not (getattr(anim, "replace_mobject_with_target_in_scene", False) or isinstance(anim.mobject, ValueTracker))

    def _start(self, start, anim):
        target = anim.mobject
        anim._me_target = target
        anim._setup_scene(self._scene)
        # Like Scene.play: anything animated that isn't on screen yet gets added.
        if not anim.is_introducer() and target not in self._scene.get_mobject_family_members():
            self._scene.add(target)
        busy = [a for _, a in self._active if getattr(a, "_me_target", None) is target]
        layer = self._layers.get(id(target))
        if busy and layer is None and self._layerable(anim) and all(self._layerable(a) for a in busy):
            # Move the animations already running on it to copies, from where they are now.
            layer = self._layers[id(target)] = _Layer(target)
            for a in busy:
                layer.resume |= bool(a.suspend_mobject_updating)
                a.mobject = target.copy()
                layer.join(a, a.mobject)
        if layer is not None and self._layerable(anim):
            anim.mobject = target.copy()
            layer.join(anim, anim.mobject)
        anim.begin()
        self._active.append((start, anim))

    def _finish(self, anim):
        anim.finish()
        layer = self._layers.get(id(getattr(anim, "_me_target", None)))
        member = next((m for m in layer.members if m[0] is anim), None) if layer else None
        if member is None:
            anim.clean_up_from_scene(self._scene)
            return
        layer.apply()
        if not anim.is_remover():  # a remover takes the object off screen and manim then restores it
            layer.bake(member)
        layer.members.remove(member)
        anim.clean_up_from_scene(self._scene)
        if anim.is_remover():
            self._scene.remove(layer.target)
        if not layer.members:
            del self._layers[id(layer.target)]
            if layer.resume:
                layer.target.resume_updating()

    def _interpolate_active(self, t):
        for start, anim in self._active:
            anim.interpolate(min(1.0, max(0.0, (t - start) / anim.run_time)))
        for layer in self._layers.values():
            layer.apply()

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
                    self._finish(item[1])
            else:
                start, factory = self._clips[self._next]
                self._next += 1
                made = factory()
                if isinstance(made, Animation) or hasattr(made, "build"):  # else: instant action
                    self._start(start, self._prepare(made))
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
        for item in list(self._active):
            self._active.remove(item)
            self._finish(item[1])

    def clean_up_from_scene(self, scene):
        scene.remove(self.mobject)
'''
