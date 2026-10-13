"""Regression checks for edits made while save/import requests are in flight.
Uses real endpoint responses, held until after a subsequent user action.
"""
import json
import os
import re
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from ui_workflow import editor, page_in, new_project, add


def save_during_edit(browser):
    with editor() as (url, home):
        target = os.path.join(home, 'race.manimstudio')
        ctx, page = page_in(browser, url, width=1800)
        page.on('dialog', lambda d: d.accept(target if d.type == 'prompt' else None))
        new_project(page)
        if page.get_by_role('button', name='Not now', exact=True).is_visible():
            page.get_by_role('button', name='Not now', exact=True).click()
        page.get_by_label('Auto-render', exact=True).uncheck()
        add(page, 'Circle')
        held = []
        def hold(route):
            response = route.fetch()
            held.append((route, response))
        page.route('**/api/project/save', hold)
        page.get_by_role('button', name='Save', exact=True).click()
        for _ in range(100):
            if held: break
            page.wait_for_timeout(100)
        assert held, 'save was sent'
        add(page, 'Square')
        assert page.title().startswith('•')
        held[0][0].fulfill(response=held[0][1])
        page.wait_for_timeout(500)
        assert page.title().startswith('•'), 'an older save must not mark the new Square as saved'
        saved = json.loads(Path(target).read_text())
        assert [o['ctor'] for o in saved['objects']] == ['Circle']
        # Recovery must retain the new edit even though the older save succeeded.
        page.wait_for_timeout(3000)
        recovery = list(Path(home, 'recovery').glob('*.json'))
        assert recovery
        assert any(any(o['ctor'] == 'Square' for o in json.loads(f.read_text())['doc']['objects']) for f in recovery)
        page.unroute('**/api/project/save', hold)
        page.get_by_role('button', name='Save', exact=True).click()
        page.wait_for_timeout(700)
        assert not page.title().startswith('•')
        assert any(o['ctor'] == 'Square' for o in json.loads(Path(target).read_text())['objects'])
        assert not page.errors, page.errors
        ctx.close()


def queued_saves(browser):
    with editor() as (url, home):
        target = os.path.join(home, 'queued.manimstudio')
        ctx, page = page_in(browser, url, width=1800)
        page.on('dialog', lambda d: d.accept(target if d.type == 'prompt' else None))
        new_project(page)
        page.get_by_label('Auto-render', exact=True).uncheck()
        add(page, 'Circle')
        held = []
        def hold(route):
            held.append((route, route.fetch()))
        page.route('**/api/project/save', hold)
        page.get_by_role('button', name='Save', exact=True).click()
        for _ in range(100):
            if held: break
            page.wait_for_timeout(100)
        assert len(held) == 1
        add(page, 'Square')
        page.get_by_role('button', name='Save', exact=True).click()
        page.wait_for_timeout(400)
        assert len(held) == 1, 'a newer write waits for the older save'
        held[0][0].fulfill(response=held[0][1])
        for _ in range(100):
            if len(held) == 2: break
            page.wait_for_timeout(100)
        assert len(held) == 2
        held[1][0].fulfill(response=held[1][1])
        page.wait_for_timeout(500)
        assert not page.title().startswith('•')
        assert [o['ctor'] for o in json.loads(Path(target).read_text())['objects']] == ['Circle', 'Square']
        assert not page.errors, page.errors
        ctx.close()


def save_after_new_project(browser):
    with editor() as (url, home):
        old_path = str(Path(home, 'original.manimstudio'))
        new_path = str(Path(home, 'replacement.manimstudio'))
        ctx, page = page_in(browser, url, width=1800)
        prompts = []
        def dialog(d):
            if d.type == 'prompt':
                prompts.append(d.default_value)
                d.accept(old_path if len(prompts) == 1 else new_path)
            else:
                d.accept()
        page.on('dialog', dialog)
        new_project(page, 'Original')
        page.get_by_label('Auto-render', exact=True).uncheck()
        add(page, 'Circle')
        held = []
        def hold(route):
            held.append((route, route.fetch()))
        page.route('**/api/project/save', hold)
        page.get_by_role('button', name='Save', exact=True).click()
        for _ in range(100):
            if held: break
            page.wait_for_timeout(100)
        assert held
        page.get_by_role('button', name='New', exact=True).click()
        page.keyboard.type('Replacement')
        page.get_by_role('dialog', name='New project').get_by_role('button', name='Create', exact=True).click()
        page.get_by_role('button', name='Don’t save', exact=True).click()
        expect(page.locator('.seq-tab')).to_have_text('Replacement.construct()')
        add(page, 'Square')
        held[0][0].fulfill(response=held[0][1])
        page.wait_for_timeout(500)
        assert page.title().startswith('•'), 'the old save cannot clear the new project’s edits'
        page.unroute('**/api/project/save', hold)
        page.get_by_role('button', name='Save', exact=True).click()
        page.wait_for_timeout(700)
        assert len(prompts) == 2, 'the new project must not inherit the old save path'
        assert [o['ctor'] for o in json.loads(Path(old_path).read_text())['objects']] == ['Circle']
        assert [o['ctor'] for o in json.loads(Path(new_path).read_text())['objects']] == ['Square']
        assert not page.errors, page.errors
        ctx.close()


def import_after_new_project(browser):
    pending_import(browser, switch_project=True)


def import_after_timeline_edit(browser):
    pending_import(browser, switch_project=False)


def pending_import(browser, switch_project):
    with editor() as (url, home):
        ctx, page = page_in(browser, url, width=1800)
        new_project(page, 'Original')
        if page.get_by_role('button', name='Not now', exact=True).is_visible():
            page.get_by_role('button', name='Not now', exact=True).click()
        page.get_by_label('Auto-render', exact=True).uncheck()
        page.get_by_role('button', name='</> Code', exact=True).click()
        page.get_by_label('Live', exact=True).uncheck()
        source = page.locator('.code-monitor textarea')
        expect(source).not_to_have_value('')
        held = []
        def hold(route):
            response = route.fetch()
            held.append((route, response))
        page.route('**/api/import_code', hold)
        source.fill('from manim import *\n\nclass Original(Scene):\n    def construct(self):\n        c = Circle()\n        self.play(Create(c))\n')
        page.get_by_role('button', name='Apply', exact=True).click()
        for _ in range(100):
            if held: break
            page.wait_for_timeout(100)
        assert held, 'import was sent'
        page.get_by_role('button', name='Program', exact=True).click()
        if switch_project:
            page.get_by_role('button', name='New', exact=True).click()
            page.keyboard.type('Replacement')
            page.get_by_role('dialog', name='New project').get_by_role('button', name='Create', exact=True).click()
            expect(page.locator('.seq-tab')).to_have_text('Replacement.construct()')
        else:
            add(page, 'Square')
        held[0][0].fulfill(response=held[0][1])
        page.wait_for_timeout(700)
        if switch_project:
            expect(page.locator('.seq-tab')).to_have_text('Replacement.construct()')
            assert not page.title().startswith('•'), 'the new empty project must stay clean'
        else:
            page.get_by_role('button', name='</> Code', exact=True).click()
            expect(page.locator('.code-monitor textarea')).to_have_value(re.compile(r'.*Square\(.*', re.DOTALL))
            assert page.title().startswith('•'), 'the newer timeline edit must remain unsaved'
        assert not page.errors, page.errors
        ctx.close()


if __name__ == '__main__':
    wanted = sys.argv[1:]
    failed = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        for scenario in [save_during_edit, queued_saves, save_after_new_project, import_after_new_project, import_after_timeline_edit]:
            if wanted and scenario.__name__ not in wanted:
                continue
            try:
                scenario(browser)
                print('PASS', scenario.__name__, flush=True)
            except Exception as e:
                failed.append(scenario.__name__)
                print('FAIL', scenario.__name__, str(e), flush=True)
        browser.close()
    sys.exit(bool(failed))
