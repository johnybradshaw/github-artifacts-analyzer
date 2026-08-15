import { Octokit } from '@octokit/rest';
import chalk from 'chalk';

class GitHubArtifactsAnalyzer {
  private octokit: Octokit;
  constructor(token) {
    this.octokit = new Octokit({
      auth: token,
      userAgent: 'github-artifacts-analyzer/1.0.0'
    });
  }

  // Defaults are merged rather than declared as a whole-object parameter
  // default: that default only applies when the argument is omitted entirely,
  // so a caller passing `{ resolveWorkflows: true }` would leave minSize and
  // includeExpired undefined. This is published as a library, so partial
  // options objects are the normal case, not a mistake.
  async analyzeAllRepositories(username, opts = {}) {
    const options = { includeExpired: false, minSize: 0, resolveWorkflows: false, ...opts };
    // Get authenticated user if no username provided
    if (!username) {
      const { data: user } = await this.octokit.users.getAuthenticated();
      username = user.login;
    }

    console.log(chalk.blue(`\n📊 Analyzing repositories for user: ${username}\n`));

    // Get all repositories for the user - both public and private
    const repositories = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        // Try authenticated user's repos first (includes private repos)
        const { data: repos } = await this.octokit.repos.listForAuthenticatedUser({
          visibility: 'all', // Gets both public and private repos
          per_page: 100,
          page,
          sort: 'updated'
        });

        if (repos.length === 0) {
          hasMore = false;
        } else {
          // Filter to only repos owned by the target user (not organizations)
          const userRepos = repos.filter(repo => 
            repo.owner.login === username && !repo.fork
          );

          // Process repositories in batches to avoid rate limiting
          for (const repo of userRepos) {
            console.log(chalk.gray(`  Checking ${repo.full_name}${repo.private ? ' (private)' : ''}...`));
            try {
              const analysis = await this.analyzeRepository(repo.owner.login, repo.name, options);
              repositories.push(analysis);
              
              if (analysis.totalArtifacts > 0) {
                console.log(chalk.green(`    ✓ Found ${analysis.totalArtifacts} artifacts (${this.formatBytes(analysis.totalSizeBytes)})`));
              }
            } catch (error) {
              console.log(chalk.yellow(`    ⚠ Skipped (${error?.message || 'Unknown error'})`));
            }

            // Small delay to be respectful to the API
            await this.sleep(100);
          }
          page++;
        }
      } catch (error) {
        // Fallback to public repos if authenticated call fails
        if (error.status === 401 || error.status === 403) {
          console.log(chalk.yellow('⚠ Using public repositories only (authentication issue)'));
          return this.analyzePublicRepositories(username, options);
        }
        throw error;
      }
    }

    // Calculate summary statistics
    const summary = this.calculateSummary(repositories);

    return {
      repositories,
      summary
    };
  }

  // Same defaulting rule as analyzeAllRepositories.
  async analyzePublicRepositories(username, opts = {}) {
    const options = { includeExpired: false, minSize: 0, resolveWorkflows: false, ...opts };
    const repositories = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const { data: repos } = await this.octokit.repos.listForUser({
        username,
        per_page: 100,
        page,
        type: 'owner' // Only repositories owned by the user, not organizations
      });

      if (repos.length === 0) {
        hasMore = false;
      } else {
        // Process repositories in batches to avoid rate limiting
        for (const repo of repos) {
          console.log(chalk.gray(`  Checking ${repo.full_name}...`));
          try {
            const analysis = await this.analyzeRepository(repo.owner.login, repo.name, options);
            repositories.push(analysis);
            
            if (analysis.totalArtifacts > 0) {
              console.log(chalk.green(`    ✓ Found ${analysis.totalArtifacts} artifacts (${this.formatBytes(analysis.totalSizeBytes)})`));
            }
          } catch (error) {
            console.log(chalk.yellow(`    ⚠ Skipped (${error?.message || 'Unknown error'})`));
          }

          // Small delay to be respectful to the API
          await this.sleep(100);
        }
        page++;
      }
    }

    // Calculate summary statistics
    const summary = this.calculateSummary(repositories);

    return {
      repositories,
      summary
    };
  }

  // Same defaulting rule as analyzeAllRepositories.
  async analyzeRepository(owner, repo, opts = {}) {
    const options = { includeExpired: false, minSize: 0, resolveWorkflows: false, ...opts };
    const analysis = {
      owner,
      name: repo,
      fullName: `${owner}/${repo}`,
      hasWorkflows: false,
      workflows: [],
      artifacts: [],
      totalArtifacts: 0,
      totalSizeBytes: 0,
      activeArtifacts: 0,
      expiredArtifacts: 0,
      activeSizeBytes: 0,
      expiredSizeBytes: 0
    };

    try {
      // Get workflows for the repository. Artifact discovery no longer depends
      // on this, but resolveWorkflowNames looks names up in it, so it has to be
      // the complete set: an unpaginated call returns only the first 30, and a
      // repo with more than that would silently fall back to the run's display
      // title ("Push on main") in place of the workflow name.
      const workflowsData = await this.octokit.paginate(
        this.octokit.actions.listRepoWorkflows,
        { owner, repo, per_page: 100 }
      );

      analysis.hasWorkflows = workflowsData.length > 0;
      analysis.workflows = workflowsData.map(w => ({
        id: w.id,
        name: w.name,
        path: w.path,
        state: w.state
      }));

      // Enumerate artifacts directly. Walking workflows -> runs -> artifacts
      // capped out at 100 runs per workflow (silently undercounting) and cost
      // O(workflows x runs) requests; this is the complete set in one
      // paginated sweep. See issues #3 and #4.
      const artifacts = await this.octokit.paginate(
        this.octokit.actions.listArtifactsForRepo,
        { owner, repo, per_page: 100 }
      );

      // A repo can hold artifacts from workflows that have since been deleted,
      // so artifacts are authoritative for whether Actions was ever used.
      if (artifacts.length > 0) {
        analysis.hasWorkflows = true;
      }

      for (const artifact of artifacts) {
        if (artifact.size_in_bytes < options.minSize) {
          continue;
        }

        const isExpired = artifact.expired || (artifact.expires_at ? new Date(artifact.expires_at) < new Date() : false);

        if (isExpired && !options.includeExpired) {
          continue;
        }

        analysis.artifacts.push({
          id: artifact.id,
          name: artifact.name,
          sizeInBytes: artifact.size_in_bytes,
          createdAt: new Date(artifact.created_at || Date.now()),
          updatedAt: new Date(artifact.updated_at || Date.now()),
          expiresAt: new Date(artifact.expires_at || Date.now()),
          expired: isExpired,
          workflowRunId: artifact.workflow_run?.id ?? null,
          // This endpoint does not carry the workflow name. Resolving it costs
          // one request per distinct run, so it is opt-in via resolveWorkflows;
          // the branch is always available and is a usable fallback.
          workflowName: null,
          headBranch: artifact.workflow_run?.head_branch ?? null,
          headSha: artifact.workflow_run?.head_sha ?? null
        });
      }

      if (options.resolveWorkflows) {
        await this.resolveWorkflowNames(owner, repo, analysis.artifacts, analysis.workflows);
      }

      // Calculate statistics
      analysis.totalArtifacts = analysis.artifacts.length;
      analysis.totalSizeBytes = analysis.artifacts.reduce((sum, a) => sum + a.sizeInBytes, 0);
      analysis.activeArtifacts = analysis.artifacts.filter(a => !a.expired).length;
      analysis.expiredArtifacts = analysis.artifacts.filter(a => a.expired).length;
      analysis.activeSizeBytes = analysis.artifacts.filter(a => !a.expired).reduce((sum, a) => sum + a.sizeInBytes, 0);
      analysis.expiredSizeBytes = analysis.artifacts.filter(a => a.expired).reduce((sum, a) => sum + a.sizeInBytes, 0);

    } catch (error) {
      if (error?.status === 404) {
        throw new Error('Repository not found or no access');
      } else if (error?.status === 403) {
        throw new Error('Access forbidden - check token permissions');
      } else {
        throw error;
      }
    }

    return analysis;
  }

  // Fills in workflowName for artifacts, one request per distinct workflow run
  // (not per artifact). Failures leave workflowName null rather than aborting
  // the analysis - a missing label must never lose an artifact from the totals.
  async resolveWorkflowNames(owner, repo, artifacts, workflows = []) {
    const runIds = [...new Set<number>(artifacts.map(a => a.workflowRunId).filter(id => id != null))];
    const namesByRunId = new Map<number, string | null>();

    // The run object carries workflow_id plus its own display title (e.g.
    // "Push on main"). Prefer the actual workflow name from the list we
    // already fetched; fall back to the run title only if the workflow has
    // since been deleted.
    const workflowNamesById = new Map<number, string>(
      workflows.map(w => [w.id, w.name])
    );

    for (const runId of runIds) {
      try {
        const { data: run } = await this.octokit.actions.getWorkflowRun({
          owner,
          repo,
          run_id: runId
        });
        namesByRunId.set(runId, workflowNamesById.get(run.workflow_id) ?? run.name);
      } catch (error) {
        namesByRunId.set(runId, null);
      }
      await this.sleep(50);
    }

    for (const artifact of artifacts) {
      artifact.workflowName = namesByRunId.get(artifact.workflowRunId) ?? null;
    }
  }

  calculateSummary(repositories) {
    return {
      totalRepositories: repositories.length,
      repositoriesWithWorkflows: repositories.filter(r => r.hasWorkflows).length,
      repositoriesWithArtifacts: repositories.filter(r => r.totalArtifacts > 0).length,
      totalArtifacts: repositories.reduce((sum, r) => sum + r.totalArtifacts, 0),
      totalSizeBytes: repositories.reduce((sum, r) => sum + r.totalSizeBytes, 0),
      activeArtifacts: repositories.reduce((sum, r) => sum + r.activeArtifacts, 0),
      expiredArtifacts: repositories.reduce((sum, r) => sum + r.expiredArtifacts, 0),
      activeSizeBytes: repositories.reduce((sum, r) => sum + r.activeSizeBytes, 0),
      expiredSizeBytes: repositories.reduce((sum, r) => sum + r.expiredSizeBytes, 0)
    };
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async deleteArtifact(owner, repo, artifactId) {
    try {
      await this.octokit.actions.deleteArtifact({
        owner,
        repo,
        artifact_id: artifactId
      });
      return true;
    } catch (error) {
      console.error(`Failed to delete artifact ${artifactId}:`, error.message);
      return false;
    }
  }
}

export { GitHubArtifactsAnalyzer };