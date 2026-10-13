"""Explanation authoring preserves native statement order, identities, and exact boundary states."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from mathengine import codegen, runtime
from mathengine.importer import import_code
from mathengine.project import load_project, save_project
from conftest import anim, animate, doc, obj, play, wait

OPS = Path(__file__).parent.parent / 'frontend' / 'scripts' / 'storyboard_ops.mjs'
needs_node = pytest.mark.skipif(not shutil.which('node') or not (OPS.parent.parent / 'node_modules' / 'vite').exists(), reason='needs frontend dependencies')


def author(d, *ops, measured=None):
    result = subprocess.run(['node', str(OPS)], input=json.dumps({'doc': d, 'ops': ops, 'measured': measured}), capture_output=True, text=True, cwd=OPS.parent.parent, timeout=60)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def beat(id, steps=(), script=''):
    return {'id': id, 'title': id, 'steps': list(steps), 'script': script, 'cues': []}


@needs_node
def test_imported_plays_and_holds_become_beats_without_rewriting_code():
    d = doc([obj('o', 'dot', 'Dot')], [play(anim('draw', 'Create', 'dot'), id='first'), wait(2), play(animate('move', 'dot', '.shift(RIGHT)'), id='second')])
    before = codegen.generate(d).source
    result = author(d, {'op': 'adopt'})
    assert [b['steps'] for b in result['beats']] == [['first', 'w'], ['second']]
    assert codegen.generate(result['doc']).source == before
    assert result['boundaries'][0] == {'start': {'id': 'first', 'edge': 'start'}, 'end': {'id': 'w', 'edge': 'end'}}


@needs_node
def test_empty_planning_card_receives_its_actions_before_the_next_beat():
    d = doc([obj('o', 'dot', 'Dot')], [play(anim('a', 'Create', 'dot'), id='first'), wait(1, id='last')])
    d['storyboard'] = {'beats': [beat('intro', ['first']), beat('plan', script='Explain the point'), beat('outro', ['last'])]}
    result = author(d, {'op': 'append', 'beat': 'plan', 'steps': [play(animate('m', 'dot', '.shift(RIGHT)'), id='move')]})
    assert [s['id'] for s in result['doc']['timeline']] == ['first', 'move', 'last']
    assert result['beats'][1]['steps'] == ['move']
    assert result['beats'][1]['script'] == 'Explain the point'
    assert [o['id'] for o in result['doc']['objects']] == ['o']


@needs_node
def test_blocks_stay_whole_and_cues_follow_splits():
    d = doc([], [{'id': 'loop', 'kind': 'block', 'head': 'for i in range(2)'}, wait(1, id='inside'), {'id': 'end', 'kind': 'end'}, wait(1, id='after')])
    b = beat('b', ['loop', 'inside', 'end', 'after'])
    b['cues'] = [{'id': 'c', 'phrase': 'then hold', 'step': 'after', 'edge': 'start', 'offset': .2}]
    d['storyboard'] = {'beats': [b]}
    bad = author(d, {'op': 'split', 'beat': 'b', 'step': 'inside'})
    assert bad['results'] == [False]
    good = author(d, {'op': 'split', 'beat': 'b', 'step': 'after'})
    assert [b['steps'] for b in good['beats']] == [['loop', 'inside', 'end'], ['after']]
    assert not good['beats'][0]['cues'] and good['beats'][1]['cues'][0]['id'] == 'c'


@needs_node
def test_independent_beats_move_but_shared_state_and_dependencies_do_not():
    d = doc([obj('a', 'a', 'Dot'), obj('b', 'b', 'Dot')], [play(anim('aa', 'Create', 'a'), id='sa'), play(anim('bb', 'Create', 'b'), id='sb')])
    d['storyboard'] = {'beats': [beat('A', ['sa']), beat('B', ['sb'])]}
    moved = author(d, {'op': 'move', 'beat': 'A', 'delta': 1})
    assert moved['results'] == [None]
    assert [s['id'] for s in moved['doc']['timeline']] == ['sb', 'sa']
    d['objects'][1]['link'] = {'kind': 'attach', 'to': 'a', 'offset': [1, 0]}
    blocked = author(d, {'op': 'move', 'beat': 'A', 'delta': 1})
    assert 'both use' in blocked['results'][0]
    assert blocked['doc']['timeline'] == d['timeline']
    d['objects'][1].pop('link')
    d['timeline'][1] = {'id': 'sb', 'kind': 'code', 'code': 'self.clear()'}
    assert 'Python' in author(d, {'op': 'move', 'beat': 'A', 'delta': 1})['results'][0]


@needs_node
def test_native_measured_timing_owns_beat_duration():
    d = doc([obj('o', 'dot', 'Dot')], [play(anim('a', 'Create', 'dot'), id='s')])
    measured = runtime.run(d, None, False).to_json()
    result = author(d, measured=measured)
    assert result['spans'] == [{'start': 0, 'end': measured['duration'], 'estimated': False}]


def test_exact_boundaries_disambiguate_instant_actions_at_the_same_time():
    d = doc([obj('o', 'dot', 'Dot')], [{'id': 'add', 'kind': 'add', 'targets': ['dot']}, {'id': 'remove', 'kind': 'remove', 'targets': ['dot']}, wait(1)])
    before = runtime.run(d, render=False, boundary={'id': 'add', 'edge': 'start'})
    shown = runtime.run(d, render=False, boundary={'id': 'add', 'edge': 'end'})
    gone = runtime.run(d, render=False, boundary={'id': 'remove', 'edge': 'end'})
    assert not before.error and not shown.error and not gone.error
    assert before.duration == shown.duration == gone.duration == 0
    assert not before.objects[0]['visible'] and shown.objects[0]['visible'] and not gone.objects[0]['visible']


def test_boundary_runs_the_complete_native_animation_and_not_next_statement():
    d = doc([obj('o', 'dot', 'Dot')], [play(anim('a', 'Create', 'dot'), id='draw'), play(animate('m', 'dot', '.shift(RIGHT * 3)'), id='move'), {'id': 'rm', 'kind': 'remove', 'targets': ['dot']}])
    before = runtime.run(d, render=False, boundary={'id': 'move', 'edge': 'start'})
    after = runtime.run(d, render=False, boundary={'id': 'move', 'edge': 'end'})
    assert not after.error and after.objects[0]['visible']
    assert before.objects[0]['center'] == [0, 0] and after.objects[0]['center'] == [3, 0]


def test_block_boundary_surrounds_all_iterations_and_reports_skipped_boundary():
    d = doc([obj('o', 'dot', 'Dot')], [{'id': 'add', 'kind': 'add', 'targets': ['dot']}, {'id': 'loop', 'kind': 'block', 'head': 'for i in range(3)'}, play(animate('a', 'dot', '.shift(RIGHT)'), id='move'), {'id': 'end', 'kind': 'end'}])
    before = runtime.run(d, render=False, boundary={'id': 'loop', 'edge': 'start'})
    after = runtime.run(d, render=False, boundary={'id': 'end', 'edge': 'end'})
    assert before.objects[0]['center'] == [0, 0] and after.objects[0]['center'] == [3, 0]
    d['timeline'][2]['disabled'] = True
    skipped = runtime.run(d, render=False, boundary={'id': 'move', 'edge': 'end'})
    assert 'did not execute' in skipped.error['message']


def test_story_metadata_survives_save_reopen_and_code_edit(tmp_path):
    src = 'from manim import *\n\nclass Lesson(Scene):\n    def construct(self):\n        dot = Dot()\n        self.play(Create(dot))\n'
    d = import_code(src).doc
    sid = d['timeline'][0]['id']
    b = beat('intro', [sid], 'This is a point.')
    b['cues'] = [{'id': 'c', 'phrase': 'point', 'step': sid, 'edge': 'end', 'offset': 0}]
    d['storyboard'] = {'beats': [b]}
    path = tmp_path / 'lesson.manimstudio'
    save_project(path, d)
    reopened = load_project(path)
    assert reopened['storyboard'] == d['storyboard']
    plain = codegen.generate(reopened, latex=True).source
    reread = import_code(plain, base=reopened).doc
    assert reread['storyboard'] == reopened['storyboard']
    assert reread['timeline'][0]['id'] == sid
    assert 'storyboard' not in plain


@needs_node
def test_deleting_last_action_keeps_the_explanation_and_script():
    d = doc([], [wait(1, id='hold')])
    d['storyboard'] = {'beats': [beat('explain', ['hold'], 'A useful explanation.')]}
    result = author(d, {'op': 'remove', 'ids': ['hold']})
    assert result['beats'] == [beat('explain', script='A useful explanation.')]


@needs_node
def test_terms_and_python_constructor_references_block_unsafe_reordering():
    d = doc([obj('a', 'a', 'MathTex'), obj('b', 'b', 'MathTex')], [play(anim('a1', 'Create', 'a'), id='s1'), play(anim('a2', 'TransformTerms', 'b'), id='s2')])
    d['timeline'][1]['anims'][0]['terms'] = {'to': 'a', 'pairs': []}
    d['storyboard'] = {'beats': [beat('one', ['s1']), beat('two', ['s2'])]}
    assert 'both use' in author(d, {'op': 'move', 'beat': 'one', 'delta': 1})['results'][0]
    d['timeline'][1]['anims'][0] = anim('a2', 'Create', 'b')
    d['objects'][1]['args'] = {'*': 'a.get_center()'}
    assert 'both use' in author(d, {'op': 'move', 'beat': 'one', 'delta': 1})['results'][0]


def test_optional_storyboard_metadata_is_normalized_on_load():
    from mathengine.project import upgrade
    d = doc([], [])
    d['storyboard'] = {'beats': [None, {'id': 'b', 'title': None, 'steps': None, 'script': 3, 'cues': [None]}]}
    assert upgrade(d)['storyboard']['beats'] == [beat('b') | {'title': 'Explanation'}]


def store_author(d, *edits):
    script = OPS.with_name('storyboard_store.mjs')
    result = subprocess.run(['node', str(script)], input=json.dumps({'doc': d, 'beat': 'b', 'edits': edits}), capture_output=True, text=True, cwd=OPS.parent.parent, timeout=60)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@needs_node
def test_canvas_result_edit_records_native_rotation_and_preserves_starting_object():
    d = doc([obj('o', 'square', 'Square', pos=[0, 0])], [play(anim('draw', 'Create', 'square'), id='intro')])
    d['storyboard'] = {'beats': [beat('b', ['intro'])]}
    edit = {'op': 'transform', 'id': 'o', 'delta': {'rotate': 90}, 'center': [0, 0]}
    result = store_author(d, edit)
    assert result['doc']['objects'] == d['objects']
    rotation = result['doc']['timeline'][-1]['anims'][0]
    assert rotation['cls'] == 'Rotate' and rotation['args']['angle'] == '90 * DEGREES'
    assert result['doc']['storyboard']['beats'][0]['steps'][-1] == result['doc']['timeline'][-1]['id']
    assert result['dirty'] and result['past'] == 1
    undone = store_author(d, edit, {'op': 'undo'})
    assert undone['doc'] == d
    redone = store_author(d, edit, {'op': 'undo'}, {'op': 'redo'})
    assert redone['doc']['timeline'][-1]['anims'][0]['cls'] == 'Rotate'


@needs_node
def test_result_move_and_parameter_sweep_compile_to_native_manim():
    d = doc([obj('o', 'dot', 'Dot', pos=[0, 0]), obj('p', 'h', 'ValueTracker', args={'*': '1'})], [play(anim('draw', 'Create', 'dot'), id='intro')])
    d['storyboard'] = {'beats': [beat('b', ['intro'])]}
    result = store_author(d, {'op': 'transform', 'id': 'o', 'delta': {'move': [2, 1]}, 'center': [0, 0]}, {'op': 'animate', 'name': 'h', 'value': .1, 'duration': 2})
    assert result['doc']['objects'] == d['objects']
    generated = codegen.generate(result['doc']).source
    assert '.animate.move_to(np.array([2, 1, 0]))' in generated
    assert '.animate(run_time=2).set_value(0.1)' in generated
    measured = runtime.run(result['doc'], render=False)
    assert not measured.error and measured.values['h'] == pytest.approx(.1)
    assert next(o for o in measured.objects if o['id'] == 'o')['center'] == [2, 1]


@needs_node
def test_script_metadata_does_not_invalidate_native_render_fingerprint():
    d = doc([], [wait(1)])
    d['storyboard'] = {'beats': [beat('b', ['w'])]}
    result = store_author(d, {'op': 'rename', 'title': 'Explain the limit'})
    assert result['doc']['storyboard']['beats'][0]['title'] == 'Explain the limit'
    assert not result['keyChanged']
