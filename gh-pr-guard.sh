#!/bin/bash
# gh-pr-guard — Claude Code PreToolUse hook
#
# Blocks destructive GitHub pull-request operations before they execute.
# Claude Code invokes this script with the tool-call payload as JSON on stdin.
# Exiting with code 2 causes Claude Code to abort the tool call and show the
# stderr message to the model as feedback.
#
# Blocked commands: gh pr close, gh pr merge, gh pr delete

node -e "
process.stdin.resume();
let data = '';
process.stdin.on('data', function(d) { data += d; });
process.stdin.on('end', function() {
    try {
        var input = JSON.parse(data);
        var cmd = (input.tool_input || {}).command || '';
        if (/gh\\s+pr\\s+(close|merge|delete)\\b/.test(cmd)) {
            process.stderr.write(
                'BLOCKED: You are not allowed to run \"gh pr close\", ' +
                '\"gh pr merge\", or \"gh pr delete\". ' +
                'You must NEVER close, merge, or delete pull requests. ' +
                'Pull request creation is handled automatically by the system ' +
                'after your work is complete.\n'
            );
            process.exit(2);
        }
    } catch (e) {
        // JSON parse error — allow the tool call through
    }
});
"
