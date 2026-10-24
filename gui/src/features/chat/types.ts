import type { ApprovalDetail, ChangedFile, PlanStep } from '../../lib/api';

/* Ronin Code — chat timeline model. One entry per rendered row. */

export type TimelineItem =
  | { kind: 'message'; id: number; role: 'user' | 'assistant' | 'error'; text: string }
  | {
      kind: 'changes';
      id: number;
      files: ChangedFile[];
      undoing: boolean;
      undone: boolean;
      costUsd?: number;
      costEstimated?: boolean;
      durationMs?: number;
    }
  | {
      kind: 'approval';
      id: number;
      approvalId: string;
      approvalKind: 'command' | 'write_outside';
      detail: ApprovalDetail;
      resolved: boolean | null;
    }
  | {
      kind: 'plan';
      id: number;
      planId: string;
      task: string;
      steps: PlanStep[];
      status: 'pending' | 'building' | 'done' | 'rejected';
    };
