#!/bin/sh
# Bumpsmith sandbox git wrapper. Git dependencies are served from shallow local copies
# (src/sandbox/git-deps.ts):
#  - `git fetch` gets --update-shallow so it accepts their shallow history;
#  - `git clone --local SRC DEST` from a shallow SRC copies the repository instead (git
#    ignores --local for shallow sources and drops the remote-tracking refs uv relies on).
case " $* " in
  *" clone "*"--local "*)
    for last; do :; done
    dest=$last
    src=$(eval "echo \"\${$(($# - 1))}\"")
    gitdir=
    if [ -f "$src/shallow" ]; then gitdir=$src; elif [ -f "$src/.git/shallow" ]; then gitdir=$src/.git; fi
    if [ -n "$gitdir" ] && [ ! -e "$dest" ]; then
      mkdir -p "$dest" && cp -a "$gitdir" "$dest/.git" && exec /usr/bin/git -C "$dest" config core.bare false
    fi
    ;;
esac
found=0
for a do
  shift
  set -- "$@" "$a"
  if [ "$found" = 0 ] && [ "$a" = fetch ]; then set -- "$@" --update-shallow; found=1; fi
done
exec /usr/bin/git "$@"
