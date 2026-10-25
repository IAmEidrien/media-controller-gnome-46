// Repository-local promotion controller. Candidate code never runs with this token.
'use strict';
const fs = require('node:fs');
const HOURS = 72 * 60 * 60 * 1000;
const CI = 'testing-ci.yml';

function receipt(runs, sha) {
    // Do not filter by SHA before selecting the newest push: a force-push back
    // to a previously tested SHA must still restart the quiet period.
    const latest = runs.filter(r => ['push', 'workflow_dispatch'].includes(r.event))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];
    return latest?.head_sha === sha ? latest : null;
}

function decision({pr, sha, run, now = Date.now(), extraRuns = [], statuses = []}) {
    if (!pr || pr.state !== 'open' || pr.draft) return 'PR unavailable or draft';
    if (pr.labels.some(l => l.name === 'do-not-merge')) return 'Paused by do-not-merge';
    if (pr.head.sha !== sha) return 'Testing changed';
    if (!run || run.head_sha !== sha || !Number.isFinite(Date.parse(run.created_at))) return 'No current push receipt';
    if (now - Date.parse(run.created_at) < HOURS) return '72-hour quiet period is not complete';
    if (run.status !== 'completed' || run.conclusion !== 'success') return 'Required validation has not passed';
    if (extraRuns.some(r => r.status !== 'completed' || r.conclusion !== 'success')) return 'Additional push CI has not passed';
    if (statuses.some(s => s.state !== 'success')) return 'Commit status has not passed';
    if (pr.mergeable !== true || pr.mergeable_state !== 'clean') return 'Merge is not clean';
    return null;
}

async function main({github, context, core}) {
    const {owner, repo} = context.repo;
    const args = {owner, repo};
    const {data: repository} = await github.rest.repos.get(args);
    const base = repository.default_branch;
    const report = async message => {
        core.info(message);
        await core.summary.addHeading('Testing promotion').addRaw(message).write();
    };
    const ref = async name => (await github.rest.git.getRef({...args, ref: `heads/${name}`})).data.object.sha;
    let sha;
    try { sha = await ref('testing'); } catch (error) {
        if (error.status !== 404) throw error;
        return report('No testing branch. Create it from the default branch to begin.');
    }
    const baseSha = await ref(base);
    const {data: compared} = await github.rest.repos.compareCommits({...args, base: baseSha, head: sha});
    if (!compared.ahead_by) return report('Testing has no unmerged commits.');
    // Incorporate release changes without rewriting history. Validate the new
    // head and start a fresh quiet period; never merge a stale integration.
    if (compared.behind_by) {
        try {
            const merged = await github.rest.repos.merge({...args, base: 'testing', head: baseSha,
                commit_message: `Merge ${base} into testing before validation`});
            if (merged.status !== 204) {
                await github.rest.actions.createWorkflowDispatch({...args, workflow_id: CI, ref: 'testing'});
                return report('Release changes merged into testing; validation and the 72-hour period restarted.');
            }
        } catch (error) {
            if (error.status === 409) return report('Testing conflicts with the release branch; maintainer resolution required.');
            throw error;
        }
        return report('Release integration changed; retry on the next run.');
    }
    let prs = await github.paginate(github.rest.pulls.list, {...args, state:'open', base,
        head: `${owner}:testing`, per_page:100});
    let pr = prs.find(p => p.head.repo?.full_name === repository.full_name && p.head.ref === 'testing');
    if (!pr) {
        try {
            pr = (await github.rest.pulls.create({...args, base, head:'testing',
                title:`Promote testing to ${base}`,
                body:'Promotes the persistent `testing` branch after 72 quiet hours and passing CI.\n\nEvery push restarts the timer. Apply `do-not-merge` to pause automatic promotion; remove it to resume. You may merge early with **Create a merge commit**. Keep the testing branch. See `TESTING-WORKFLOW.md`.'})).data;
        } catch (error) {
            if (error.status !== 422) throw error;
            prs = await github.paginate(github.rest.pulls.list, {...args,state:'open',base,head:`${owner}:testing`,per_page:100});
            pr = prs.find(p => p.head.repo?.full_name === repository.full_name);
            if (!pr) throw error;
        }
    }
    try { await github.rest.issues.getLabel({...args, name:'do-not-merge'}); }
    catch (error) {
        if (error.status !== 404) throw error;
        try { await github.rest.issues.createLabel({...args,name:'do-not-merge',color:'b60205',
            description:'Pause automatic testing promotion'}); }
        catch (createError) { if (createError.status !== 422) throw createError; }
    }
    const getRuns = async () => (await github.rest.actions.listWorkflowRuns({...args,
        workflow_id:CI, branch:'testing',per_page:100})).data.workflow_runs;
    const runs = await getRuns();
    let run = receipt(runs, sha);
    if (!run) {
        // Bot pushes do not necessarily trigger push workflows. Explicit dispatch
        // supplies a conservative server-timed receipt and runs the same CI.
        await github.rest.actions.createWorkflowDispatch({...args,workflow_id:CI,ref:'testing'});
        return report(`PR #${pr.number}: started validation for the current head; no promotion without a receipt.`);
    }
    if (repository.delete_branch_on_merge || !repository.allow_merge_commit)
        throw new Error('Enable merge commits and disable automatic branch deletion before promotion.');
    const additional = (await github.rest.actions.listWorkflowRunsForRepo({...args,
        branch:'testing',event:'push',head_sha:sha,per_page:100})).data.workflow_runs;
    // The receipt includes the full regression/package suite. Other push CI is
    // also a gate. Scheduled upstream-sync and duplicate PR approval runs are
    // orchestration/duplicates, not substitute evidence for push validation.
    const latest = new Map();
    for (const item of additional.sort((a,b)=>b.id-a.id))
        if (!latest.has(item.workflow_id)) latest.set(item.workflow_id,item);
    const extraRuns = [...latest.values()].filter(r =>
        !['.github/workflows/promote-testing.yml', '.github/workflows/testing-ci.yml'].includes(r.path));
    const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef,
        {...args,ref:sha,per_page:100});
    const latestStatuses = new Map();
    for (const s of statuses) if (!latestStatuses.has(s.context)) latestStatuses.set(s.context,s);
    const reviews = await github.paginate(github.rest.pulls.listReviews,{...args,pull_number:pr.number,per_page:100});
    const latestReviews = new Map();
    for (const review of reviews) if (review.user && review.state !== 'COMMENTED') latestReviews.set(review.user.id,review.state);
    if ([...latestReviews.values()].includes('CHANGES_REQUESTED')) return report(`PR #${pr.number}: changes requested.`);
    // Refresh every mutable gate immediately before merging, including the
    // latest receipt (pushes back to the same SHA also reset the timer).
    pr = (await github.rest.pulls.get({...args,pull_number:pr.number})).data;
    run = receipt(await getRuns(),sha);
    if (await ref('testing') !== sha || await ref(base) !== baseSha)
        return report('A branch changed during evaluation; retry on the next run.');
    const blocked = decision({pr,sha,run,extraRuns,statuses:[...latestStatuses.values()]});
    if (blocked) return report(`PR #${pr.number}: ${blocked}.`);
    const merged = await github.rest.pulls.merge({...args,pull_number:pr.number,sha,merge_method:'merge'});
    if (!merged.data.merged) throw new Error(merged.data.message || 'GitHub declined the merge.');
    await report(`PR #${pr.number} promoted with a merge commit. Original commits and testing branch retained.`);
}
module.exports = {main,decision,receipt,HOURS};
