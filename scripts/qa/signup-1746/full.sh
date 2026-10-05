#!/usr/bin/env bash
# usage: full.sh EMAIL NAME [stop-before-final]
source ~/code/bb-worktrees/s1746/flows/lib2.sh
phaseA "$1" $2; phaseB $2; sleep 2; readwords $2; cat $FL/words-$2.txt; echo
phaseC $2; phaseD $2; confirmtap
