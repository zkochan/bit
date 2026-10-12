// Canonical three-way merge pushes added/updated rows after concurrent Source loads.
// Their completion order can differ between two unmodified Node runs. Preserve the
// raw report in evidence; compare only adjacent rows of the same asynchronous kind
// as a multiset. Headers, other statuses, paths, duplicate counts and bytes remain
// significant. Never reorder across a status or component boundary.
function comparableMergeStdout(stdout) {
  const lines = stdout.match(/[^\n]*\n|[^\n]+$/g) || [];
  const kind = (line) => /^\t(added|updated) [^\r\n]+(?:\r?\n|$)$/.exec(line)?.[1];
  for (let start = 0; start < lines.length; ) {
    const current = kind(lines[start]);
    let end = start + 1;
    if (current) while (end < lines.length && kind(lines[end]) === current) end++;
    if (end - start > 1) lines.splice(start, end - start, ...lines.slice(start, end).sort());
    start = end;
  }
  return lines.join('');
}
module.exports = { comparableMergeStdout };
