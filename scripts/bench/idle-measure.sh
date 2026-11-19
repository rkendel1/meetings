#!/bin/bash
# idle-measure.sh <root pid> <seconds>: CPU-seconds (utime+stime, whole process tree) and RSS of a process tree.
root=$1; secs=$2; HZ=$(getconf CLK_TCK)
tree() { local p=$1; echo $p; for c in $(ps -o pid= --ppid $p); do tree $c; done; }
cpu() { local t=0; for p in $(tree $root); do s=$(cut -d')' -f2 /proc/$p/stat 2>/dev/null) || continue; set -- $s; t=$((t + ${12} + ${13})); done; echo $t; }
rss() { local t=0; for p in $(tree $root); do r=$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null); t=$((t + ${r:-0})); done; echo $t; }
c0=$(cpu); peak=0; sum=0; n=0
for i in $(seq 1 $secs); do r=$(rss); sum=$((sum + r)); n=$((n + 1)); [ $r -gt $peak ] && peak=$r; sleep 1; done
c1=$(cpu)
echo "{\"processes\": $(tree $root | wc -l), \"durationS\": $secs, \"cpuSeconds\": $(echo "scale=2; ($c1-$c0)/$HZ" | bc), \"rssAvgMiB\": $(echo "scale=1; $sum/$n/1024" | bc), \"rssPeakMiB\": $(echo "scale=1; $peak/1024" | bc)}"
