// Notification rules: "Alert <channels> when <problems> for <tags>". Shared by
// the server (which channels an alert goes to) and the browser (the rules
// page, and the monitor form's "where its alerts go"). It imports only
// filter.js, so it loads under Node too.
//
// A rule is { id, channelIds, problemIds, tagIds, tagMatch, tagExpr, downstream }.
//   problemIds  empty = every problem
//   tags        tagExpr if set (see filter.js), otherwise tagIds combined by
//               tagMatch ('any' | 'all'); no tags at all = every monitor
//   downstream  the rule also fires when the monitor at fault is untagged but
//               takes tagged monitors down with it (or brings them back)

import { parseTagExpr } from './filter.js';

// { test(tagIds) } or { error } for a rule that cannot match anything any
// more (its tags were deleted, or its expression no longer parses).
export function ruleTagTest(rule, tags) {
  if (rule.tagExpr) {
    const expr = parseTagExpr(rule.tagExpr, tags);
    if (!expr) return { test: () => true, all: true };
    return expr.error ? { error: expr.error } : { test: expr.test };
  }
  if (!rule.tagIds.length) return { test: () => true, all: true };
  const known = new Set(tags.map((t) => t.id));
  const live = rule.tagIds.filter((id) => known.has(id));
  if (!live.length) return { error: rule.tagIds.length > 1 ? 'Its tags were deleted' : 'Its tag was deleted' };
  return rule.tagMatch === 'all'
    ? { test: (ids) => live.every((t) => ids.includes(t)) }
    : { test: (ids) => live.some((t) => ids.includes(t)) };
}

export const ruleHasProblem = (rule, problemId) => !rule.problemIds.length || rule.problemIds.includes(problemId);

// What keeps a rule from sending anything, or null.
export function ruleProblem(rule, { tags, channels }) {
  const tagTest = ruleTagTest(rule, tags);
  if (tagTest.error) return `Not sending: ${tagTest.error}.`;
  if (!rule.channelIds.some((id) => channels.some((c) => c.id === id))) return 'Pick a channel to send to.';
  return null;
}

// The channels (ids) that hear about a problem with `monitorId`, given the
// monitors the alert lists as affected. `tagsOf(id)` returns a monitor's tag
// ids. Returns { channelIds: Set, ruleIds: [] }.
export function matchRules({ rules, tags, tagsOf }, { problemId, monitorId, affectedIds = [] }) {
  const channelIds = new Set();
  const ruleIds = [];
  for (const rule of rules) {
    if (!ruleHasProblem(rule, problemId)) continue;
    const { test, error } = ruleTagTest(rule, tags);
    if (error) continue;
    const hit = test(tagsOf(monitorId)) || (rule.downstream && affectedIds.some((id) => test(tagsOf(id))));
    if (!hit) continue;
    ruleIds.push(rule.id);
    for (const c of rule.channelIds) channelIds.add(c);
  }
  return { channelIds, ruleIds };
}
