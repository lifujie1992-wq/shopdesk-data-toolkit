#!/usr/bin/env python3
"""Generate a concrete launchd plist; --install loads it after config validation."""
import argparse
import json
import os
import plistlib
import subprocess
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser()
p.add_argument('--config',type=Path,required=True)
p.add_argument('--hour',type=int,default=5)
p.add_argument('--minute',type=int,default=10)
p.add_argument('--install',action='store_true')
a=p.parse_args()
if not 0<=a.hour<=23 or not 0<=a.minute<=59:p.error('invalid time')
config=a.config.resolve();cfg=json.loads(config.read_text())
python=ROOT/'.venv/bin/python'
if not python.is_file():p.error('run uv sync first')
for key in ('facts','shops'):
 value=Path(cfg[key]).expanduser();value=value if value.is_absolute() else config.parent/value
 if not value.is_file():p.error(key+' file not found')
logs=ROOT/'logs';logs.mkdir(exist_ok=True)
label='com.xdr.douyin-commission-rates'
content={'Label':label,'ProgramArguments':[str(python),'-m','commission_rates.cli','--db',
 str(ROOT/'data/jst-commission-rates.sqlite'),'daily','--config',str(config)],
 'WorkingDirectory':str(ROOT),'StartCalendarInterval':{'Hour':a.hour,'Minute':a.minute},
 'RunAtLoad':False,'ProcessType':'Background','EnvironmentVariables':{'PYTHONUNBUFFERED':'1'},
 'StandardOutPath':str(logs/'daily.out.log'),'StandardErrorPath':str(logs/'daily.err.log')}
out=ROOT/'deploy'/f'{label}.plist'
out.parent.mkdir(exist_ok=True);out.write_bytes(plistlib.dumps(content))
if a.install:
 if cfg.get('publish') and not cfg.get('acceptance_reference') and not (cfg.get('publish_partial') and cfg.get('partial_release_reason')):
  p.error('production publishing requires an accepted manual review reference')
 target=Path.home()/'Library/LaunchAgents'/out.name
 if target.exists():p.error('job already installed; review existing plist before replacing')
 target.parent.mkdir(exist_ok=True,parents=True);target.write_bytes(out.read_bytes())
 subprocess.run(['launchctl','bootstrap','gui/'+str(os.getuid()),str(target)],check=True)
 print(target)
else:print(out)
