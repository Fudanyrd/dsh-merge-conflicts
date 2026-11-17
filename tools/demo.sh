#!/bin/bash
## Create a git repository under current directory for
## plugin demonstration.
set -euo pipefail

## Create an initial git repository
if test -d ".git"; then
   echo "FATAL: git repository already exists." 1>&2
   exit 1
fi

cat << EOF > a.cc
#include <iostream>
EOF
git init
git add a.cc
git commit -m "Initial commit"
git switch -c main || true

## Create a merge conflict.

### on a feature branch:
git switch -c feat/args

cat << EOF > a.cc
#include <iostream>

int main(int argc, char **argv)
{
  return 0;
}
EOF
git add a.cc
git commit -m "Feat: add main function with arguments"

### on branch main:
git checkout main
cat << EOF > a.cc
#include <iostream>

int main(void)
{
  std::cout << "Hello, world!" << std::endl;
  return 0;
}
EOF

git add a.cc
git commit -m "Feat: print hello to stdout"

git merge feat/args

## check conflict marker
grep '<<<<<<< HEAD' a.cc
