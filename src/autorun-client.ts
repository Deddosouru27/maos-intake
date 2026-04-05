/**
 * MAOS Autorun Client — Lightweight multi-agent execution loop
 * Copy this file into any MAOS repo (pitstop, intake, runner).
 * Each agent runs its own instance with its own config.
 * 
 * Usage:
 *   import { AutorunClient } from './autorun-client';
 *   const client = new AutorunClient({ agentName: 'baker', repoName: 'pitstop', ... });
 *   client.start();
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { execSync, spawn, ChildProcess } from 'child_process';

// ============================================================
// CONFIG
// ============================================================

interface AutorunConfig {
  agentName: string;       // e.g. 'baker', 'nout', 'intaker'
  agentId: string;         // UUID from agents table
  repoName: string;        // e.g. 'pitstop', 'maos-runner', 'maos-intake'
  repoPath: string;        // absolute path to repo root
  supabaseUrl?: string;
  supabaseKey?: string;
  pollIntervalMs?: number; // default 30000 (30s)
  heartbeatMs?: number;    // default 60000 (60s)
  maxTaskDurationMs?: number; // default 1800000 (30 min)
  maxFailCount?: number;   // default 2
}

interface TaskRow {
  task_id: string;
  title: string;
  description: string;
  phase_number: number;
  exec_order: number | null;
}

// ============================================================
// AUTORUN CLIENT
// ============================================================

export class AutorunClient {
  private config: Required<AutorunConfig>;
  private supabase: SupabaseClient;
  private sessionId: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private running = false;
  private paused = false;
  private currentTaskProcess: ChildProcess | null = null;
  private tasksCompleted = 0;
  private errorsCount = 0;
  private sessionCostUsd = 0;

  constructor(config: AutorunConfig) {
    this.config = {
      supabaseUrl: process.env.SUPABASE_URL || 'https://stqhnkhcfndmhgvfyojv.supabase.co',
      supabaseKey: process.env.SUPABASE_ANON_KEY || '',
      pollIntervalMs: 30000,
      heartbeatMs: 60000,
      maxTaskDurationMs: 30 * 60 * 1000,
      maxFailCount: 2,
      ...config,
    };

    this.supabase = createClient(this.config.supabaseUrl, this.config.supabaseKey);
  }

  // ----------------------------------------------------------
  // LIFECYCLE
  // ----------------------------------------------------------

  async start(): Promise<void> {
    console.log(`[AUTORUN] Starting ${this.config.agentName} for ${this.config.repoName}`);
    this.running = true;
    this.paused = false;

    // Create session
    await this.createSession();

    // Set agent active
    await this.setAgentStatus('active');

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.config.heartbeatMs);

    // Start polling
    this.pollTimer = setInterval(() => this.pollAndExecute(), this.config.pollIntervalMs);

    // Also poll immediately
    await this.pollAndExecute();

    // Log event
    await this.logEvent('session_started', {
      session_id: this.sessionId,
      agent_name: this.config.agentName,
      repo: this.config.repoName,
    });

    console.log(`[AUTORUN] ${this.config.agentName} running. Polling every ${this.config.pollIntervalMs / 1000}s`);
  }

  async stop(): Promise<void> {
    console.log(`[AUTORUN] Stopping ${this.config.agentName}...`);
    this.running = false;

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    // Wait for current task if any
    if (this.currentTaskProcess) {
      console.log('[AUTORUN] Waiting for current task to finish...');
      // Give it 60s to finish, then kill
      await new Promise(resolve => setTimeout(resolve, 60000));
      if (this.currentTaskProcess) {
        this.currentTaskProcess.kill('SIGTERM');
      }
    }

    // Complete session
    await this.completeSession();
    await this.setAgentStatus('idle');

    await this.logEvent('session_ended', {
      session_id: this.sessionId,
      tasks_completed: this.tasksCompleted,
      errors_count: this.errorsCount,
      cost_usd: this.sessionCostUsd,
    });

    console.log(`[AUTORUN] ${this.config.agentName} stopped. Tasks: ${this.tasksCompleted}, Errors: ${this.errorsCount}`);
  }

  pause(): void {
    this.paused = true;
    console.log(`[AUTORUN] ${this.config.agentName} paused`);
  }

  resume(): void {
    this.paused = false;
    console.log(`[AUTORUN] ${this.config.agentName} resumed`);
  }

  // ----------------------------------------------------------
  // POLLING & EXECUTION
  // ----------------------------------------------------------

  private async pollAndExecute(): Promise<void> {
    if (!this.running || this.paused || this.currentTaskProcess) return;

    try {
      // Check for commands
      await this.checkCommands();

      if (!this.running) return;

      // Get next task
      const task = await this.getNextTask();
      if (!task) return;

      console.log(`[AUTORUN] Task: ${task.title}`);
      await this.logEvent('task_started', { task_id: task.task_id, task_title: task.title });

      // Execute
      const startTime = Date.now();
      const success = await this.executeTask(task);
      const durationSec = Math.round((Date.now() - startTime) / 1000);

      if (success) {
        // Mark done with outcome
        await this.completeTask(task, durationSec);
        this.tasksCompleted++;
        await this.logEvent('task_completed', {
          task_id: task.task_id,
          task_title: task.title,
          duration_seconds: durationSec,
          result: 'success',
        });
        console.log(`[AUTORUN] ✅ ${task.title} (${durationSec}s)`);

        // Write WAA
        await this.writeWAA(task, 'success', durationSec);
      } else {
        // Handle failure
        await this.handleFailure(task, durationSec);
        this.errorsCount++;
      }
    } catch (err: any) {
      console.error(`[AUTORUN] Poll error: ${err.message}`);
      this.errorsCount++;
    }
  }

  private async getNextTask(): Promise<TaskRow | null> {
    const { data, error } = await this.supabase.rpc('get_next_autorun_task', {
      p_project_name: null,
      p_agent_name: this.config.agentName,
    });

    if (error) {
      console.error(`[AUTORUN] RPC error: ${error.message}`);
      return null;
    }

    if (!data || data.length === 0) return null;
    return data[0] as TaskRow;
  }

  private async executeTask(task: TaskRow): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`[AUTORUN] ⏰ Timeout: ${task.title}`);
        if (this.currentTaskProcess) {
          this.currentTaskProcess.kill('SIGTERM');
          // Also try to kill claude processes
          try { execSync('pkill -f claude || true', { stdio: 'ignore' }); } catch {}
        }
        this.currentTaskProcess = null;
        resolve(false);
      }, this.config.maxTaskDurationMs);

      // Create feature branch
      try {
        const branchName = `feat/${this.config.agentName}-${task.task_id.substring(0, 8)}`;
        execSync(`cd ${this.config.repoPath} && git checkout -b ${branchName} 2>/dev/null || git checkout ${branchName}`, { stdio: 'pipe' });
      } catch {}

      // Build prompt for Claude Code
      const prompt = this.buildPrompt(task);

      // Run Claude Code
      this.currentTaskProcess = spawn('claude', ['-p', prompt, '--allowedTools', 'Edit,Write,Bash'], {
        cwd: this.config.repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let output = '';
      this.currentTaskProcess.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
      this.currentTaskProcess.stderr?.on('data', (data: Buffer) => { output += data.toString(); });

      this.currentTaskProcess.on('close', (code: number | null) => {
        clearTimeout(timeout);
        this.currentTaskProcess = null;

        // Try to commit, merge, cleanup
        try {
          const branchName = `feat/${this.config.agentName}-${task.task_id.substring(0, 8)}`;
          execSync(`cd ${this.config.repoPath} && git add -A && git diff --cached --quiet || git commit -m "${task.title}"`, { stdio: 'pipe' });
          
          // Run tests
          try {
            execSync(`cd ${this.config.repoPath} && npx tsc --noEmit && npm run build`, { stdio: 'pipe', timeout: 120000 });
          } catch (testErr: any) {
            console.log(`[AUTORUN] ❌ Build/tsc failed: ${task.title}`);
            // Revert
            execSync(`cd ${this.config.repoPath} && git checkout main && git branch -D ${branchName} 2>/dev/null || true`, { stdio: 'pipe' });
            resolve(false);
            return;
          }

          // Merge to main
          execSync(`cd ${this.config.repoPath} && git checkout main && git merge ${branchName} --no-ff -m "Merge ${task.title}" && git push origin main`, { stdio: 'pipe' });
          // Cleanup branch
          execSync(`cd ${this.config.repoPath} && git branch -d ${branchName} 2>/dev/null || true`, { stdio: 'pipe' });

          resolve(code === 0);
        } catch (gitErr: any) {
          console.error(`[AUTORUN] Git error: ${gitErr.message}`);
          // Try to get back to main
          try { execSync(`cd ${this.config.repoPath} && git checkout main`, { stdio: 'pipe' }); } catch {}
          resolve(false);
        }
      });

      this.currentTaskProcess.on('error', () => {
        clearTimeout(timeout);
        this.currentTaskProcess = null;
        resolve(false);
      });
    });
  }

  private buildPrompt(task: TaskRow): string {
    return `You are working on the ${this.config.repoName} repository.

TASK: ${task.title}

DESCRIPTION:
${task.description}

RULES:
- Write complete, working code. No TODOs or stubs.
- One commit = one feature. TypeScript strict.
- Build + tsc --noEmit must pass before you finish.
- Do NOT execute any DDL SQL (CREATE/ALTER/DROP). Report SQL bugs as comments.
- Pre-push: no API keys in code (grep -r "sk-" src/), build passes, tsc passes.

When done, make sure all changes are saved.`;
  }

  // ----------------------------------------------------------
  // TASK COMPLETION & FAILURE
  // ----------------------------------------------------------

  private async completeTask(task: TaskRow, durationSec: number): Promise<void> {
    await this.supabase
      .from('tasks')
      .update({
        status: 'done',
        completed_at: new Date().toISOString(),
        outcome: {
          what_done: `Completed by ${this.config.agentName} autorun client. Duration: ${durationSec}s.`,
          what_learned: 'Executed via autorun-client.',
        },
      })
      .eq('id', task.task_id);
  }

  private async handleFailure(task: TaskRow, durationSec: number): Promise<void> {
    // Get current fail count
    const { data: taskData } = await this.supabase
      .from('tasks')
      .select('context')
      .eq('id', task.task_id)
      .single();

    const context = taskData?.context || {};
    const failCount = (context.fail_count || 0) + 1;
    context.fail_count = failCount;
    context.blockers = context.blockers || [];
    context.blockers.push(`Failure #${failCount} by ${this.config.agentName} at ${new Date().toISOString()}`);

    if (failCount >= this.config.maxFailCount) {
      // Block task
      await this.supabase
        .from('tasks')
        .update({ status: 'blocked', context })
        .eq('id', task.task_id);

      await this.logEvent('task_failed', {
        task_id: task.task_id,
        task_title: task.title,
        error: `Blocked after ${failCount} failures`,
        duration_seconds: durationSec,
      });
      console.log(`[AUTORUN] 🚫 Blocked: ${task.title} (${failCount}x fail)`);
    } else {
      // Return to todo
      await this.supabase
        .from('tasks')
        .update({ status: 'todo', context })
        .eq('id', task.task_id);

      await this.logEvent('task_failed', {
        task_id: task.task_id,
        task_title: task.title,
        error: `Failure #${failCount}, returning to todo`,
        duration_seconds: durationSec,
      });
      console.log(`[AUTORUN] ❌ Failed: ${task.title} (attempt ${failCount}/${this.config.maxFailCount})`);
    }
  }

  // ----------------------------------------------------------
  // WAA
  // ----------------------------------------------------------

  private async writeWAA(task: TaskRow, result: string, durationSec: number): Promise<void> {
    await this.supabase.from('context_snapshots').insert({
      snapshot_type: 'agent_action',
      type: 'waa',
      content: {
        type: 'waa',
        agent: this.config.agentName,
        task_id: task.task_id,
        result,
        what_done: `${task.title} — completed by autorun-client`,
        what_learned: 'Automated execution',
        what_changed: [this.config.repoName],
        duration_minutes: Math.round(durationSec / 60),
      },
    });
  }

  // ----------------------------------------------------------
  // HEARTBEAT & STATUS
  // ----------------------------------------------------------

  private async heartbeat(): Promise<void> {
    try {
      await this.supabase
        .from('agents')
        .update({ last_heartbeat: new Date().toISOString(), status: 'active' })
        .eq('id', this.config.agentId);
    } catch {}
  }

  private async setAgentStatus(status: string): Promise<void> {
    await this.supabase
      .from('agents')
      .update({ status })
      .eq('id', this.config.agentId);
  }

  // ----------------------------------------------------------
  // SESSION
  // ----------------------------------------------------------

  private async createSession(): Promise<void> {
    const { data } = await this.supabase
      .from('agent_sessions')
      .insert({
        agent_id: this.config.agentId,
        status: 'active',
      })
      .select('id')
      .single();

    this.sessionId = data?.id || null;
  }

  private async completeSession(): Promise<void> {
    if (!this.sessionId) return;
    await this.supabase
      .from('agent_sessions')
      .update({
        status: 'completed',
        ended_at: new Date().toISOString(),
        tasks_completed: this.tasksCompleted,
        errors_count: this.errorsCount,
      })
      .eq('id', this.sessionId);
  }

  // ----------------------------------------------------------
  // COMMANDS (Pitstop → Runner bridge)
  // ----------------------------------------------------------

  private async checkCommands(): Promise<void> {
    const { data } = await this.supabase
      .from('autorun_commands')
      .select('*')
      .eq('processed', false)
      .or(`agent_name.eq.${this.config.agentName},agent_name.eq.all,agent_name.is.null`)
      .order('created_at', { ascending: true })
      .limit(5);

    if (!data) return;

    for (const cmd of data) {
      switch (cmd.command) {
        case 'stop':
          await this.stop();
          break;
        case 'pause':
          this.pause();
          break;
        case 'resume':
        case 'start':
          this.resume();
          break;
      }

      // Mark processed
      await this.supabase
        .from('autorun_commands')
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq('id', cmd.id);
    }
  }

  // ----------------------------------------------------------
  // LOGGING
  // ----------------------------------------------------------

  private async logEvent(eventType: string, details: Record<string, any>): Promise<void> {
    try {
      await this.supabase.from('agent_events').insert({
        agent_id: this.config.agentId,
        session_id: this.sessionId,
        event_type: eventType,
        details,
      });
    } catch (err: any) {
      console.error(`[AUTORUN] Log event error: ${err.message}`);
    }
  }
}

// ============================================================
// STANDALONE RUNNER — run with: npx tsx autorun-client.ts
// ============================================================

if (require.main === module) {
  const agentName = process.env.AGENT_NAME || 'baker';
  const agentId = process.env.AGENT_ID || '';
  const repoName = process.env.REPO_NAME || 'pitstop';
  const repoPath = process.env.REPO_PATH || process.cwd();

  if (!agentId) {
    console.error('ERROR: Set AGENT_ID environment variable');
    console.error('Agent IDs:');
    console.error('  Ноут:    9e0f8481-4126-4e26-bd5d-c65453b42041');
    console.error('  Пекарь:  5afa060f-d333-4187-b98d-a9ef04faa9d1');
    console.error('  Интакер: 24791778-b591-419f-847a-735f27076b31');
    process.exit(1);
  }

  if (!process.env.SUPABASE_ANON_KEY) {
    console.error('ERROR: Set SUPABASE_ANON_KEY environment variable');
    process.exit(1);
  }

  const client = new AutorunClient({
    agentName,
    agentId,
    repoName,
    repoPath,
  });

  client.start();

  process.on('SIGINT', () => client.stop());
  process.on('SIGTERM', () => client.stop());
}
