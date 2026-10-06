#!/usr/bin/env python3
"""把 import 路径里的 .js 后缀去掉，方便 Node 22 --experimental-strip-types 跑 TS"""
import os
import re

PATTERN = re.compile(r"from '(\.\.?/[^']+)\.js'")
REPLACEMENT = r"from '\1'"

for f in sorted(os.listdir('.')):
    if f.endswith('.ts'):
        path = f
        with open(path) as fp:
            content = fp.read()
        new_content = PATTERN.sub(REPLACEMENT, content)
        if new_content != content:
            with open(path, 'w') as fp:
                fp.write(new_content)
            print(f'fixed {f}')
        else:
            print(f'no change: {f}')