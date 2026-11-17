#!/bin/sh
# Bumpsmith: git dependencies are served from shallow local copies; let fetch accept them.
found=0
for a do
  shift
  set -- "$@" "$a"
  if [ "$found" = 0 ] && [ "$a" = fetch ]; then set -- "$@" --update-shallow; found=1; fi
done
exec /usr/bin/git "$@"
