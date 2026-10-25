"""Install this project's monthly launchd job without starting a collection."""
from datetime import datetime
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

from .model import DataError
from .monthly import configure_schedule, previous_month

LABEL='local.douyin-settle-recon.monthly'


def definition(project):
    root=Path(project).resolve();state=root/'data/monthly'
    return {'Label':LABEL,'ProgramArguments':[str(root/'.venv/bin/python'),'-u','-m','douyin_settle_recon.cli',
             'monthly','--scheduled','--state-dir',str(state),'--output',str(root/'data/runs'),
             '--template',str(root/'doc/【抖音】月度账单处理模版.xlsx'),'--queue-dir',str(root/'data/upload-queue')],
            'WorkingDirectory':str(root),'StartCalendarInterval':{'Day':1,'Hour':1,'Minute':0},
            'StartInterval':3600,'RunAtLoad':False,'ProcessType':'Background',
            'EnvironmentVariables':{'TZ':'Asia/Shanghai','PYTHONUNBUFFERED':'1','PATH':'/usr/bin:/bin:/usr/sbin:/sbin'},
            'StandardOutPath':str(state/'logs/launchd.out.log'),'StandardErrorPath':str(state/'logs/launchd.err.log')}


def _command(*args):return subprocess.run(['launchctl',*args],capture_output=True,text=True,check=False)


def _shanghai_timezone():return str(Path('/etc/localtime').resolve()).endswith('/Asia/Shanghai')


def status(project):
    root=Path(project).resolve();service=f'gui/{os.getuid()}/{LABEL}'
    probe=_command('print',service)
    result={'registered':probe.returncode==0,'label':LABEL,'plist':str(Path.home()/'Library/LaunchAgents'/(LABEL+'.plist')),
            'calendar':definition(root)['StartCalendarInterval'],'timezone':'Asia/Shanghai','retry_interval_seconds':3600}
    config=root/'data/monthly/schedule.json'
    if config.exists():
        import json
        settings=json.loads(config.read_text());result['next_due_at']=settings['next_due_at']
        result['next_reconciliation_month']=previous_month(datetime.fromisoformat(settings['next_due_at']))
    return result


def install(project):
    root=Path(project).resolve();state=root/'data/monthly';spec=definition(root)
    if not (root/'.venv/bin/python').is_file() or not (root/'doc/【抖音】月度账单处理模版.xlsx').is_file():
        raise DataError('install from a project containing .venv and the monthly Excel template')
    if not _shanghai_timezone():
        raise DataError('launchd calendar uses the Mac system timezone; set it to Asia/Shanghai before installation')
    probe=_command('print',f'gui/{os.getuid()}/{LABEL}')
    if probe.returncode==0 and 'state = running' in probe.stdout:raise DataError('monthly worker is running; preserve its progress before replacing the schedule')
    (state/'logs').mkdir(parents=True,exist_ok=True)
    configure_schedule(state)
    staged=state/'launchd'/(LABEL+'.plist');staged.parent.mkdir(parents=True,exist_ok=True)
    staged.write_bytes(plistlib.dumps(spec,sort_keys=False))
    target=Path.home()/'Library/LaunchAgents'/(LABEL+'.plist');target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists():
        backup=state/'launchd'/('previous-'+datetime.now().strftime('%Y%m%dT%H%M%S')+'.plist');shutil.copy2(target,backup)
    if probe.returncode==0:
        stopped=_command('bootout',f'gui/{os.getuid()}/{LABEL}')
        if stopped.returncode:raise DataError('could not unload the prior monthly schedule')
    shutil.copy2(staged,target)
    enabled=_command('enable',f'gui/{os.getuid()}/{LABEL}')
    if enabled.returncode:raise DataError('launchctl could not enable the monthly schedule')
    started=_command('bootstrap',f'gui/{os.getuid()}',str(target))
    if started.returncode:raise DataError('launchctl could not register the monthly schedule; inspect the generated plist')
    result=status(root)
    if not result['registered']:raise DataError('monthly schedule registration could not be verified')
    return {**result,'installed':True,'run_started':False,'logs':str(state/'logs')}
