export type DeviceOperationPriority = 'foreground' | 'interactive' | 'normal' | 'background';

interface QueueTask<T> {
  priority: DeviceOperationPriority;
  sequence: number;
  operation: () => Promise<T>;
  signal?: AbortSignal;
  abort?: () => void;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

interface QueueState {
  active: boolean;
  tasks: QueueTask<unknown>[];
}

const priorities: Record<DeviceOperationPriority, number> = {
  foreground: 0,
  interactive: 1,
  normal: 2,
  background: 3,
};

export class DeviceOperationQueueFullError extends Error {
  readonly retryable = true;
  readonly retryAfterSeconds = 5;

  constructor() {
    super('The device is busy; retry this background request shortly');
    this.name = 'DeviceOperationQueueFullError';
  }
}

export class KeyedPriorityQueue {
  private readonly queues = new Map<string, QueueState>();
  private sequence = 0;

  constructor(private readonly maximumQueuedBackgroundTasks = 32) {}

  run<T>(key: string, priority: DeviceOperationPriority, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(this.abortError(signal));
    const state = this.queues.get(key) ?? { active: false, tasks: [] };
    if (priority === 'background' && state.tasks.filter((task) => task.priority === 'background').length >= this.maximumQueuedBackgroundTasks) {
      return Promise.reject(new DeviceOperationQueueFullError());
    }

    this.queues.set(key, state);
    return new Promise<T>((resolve, reject) => {
      const task: QueueTask<T> = { priority, sequence: this.sequence++, operation, signal, resolve, reject };
      task.abort = () => {
        const index = state.tasks.indexOf(task as QueueTask<unknown>);
        if (index < 0) return;
        state.tasks.splice(index, 1);
        signal?.removeEventListener('abort', task.abort!);
        reject(this.abortError(signal));
        this.cleanup(key, state);
      };
      signal?.addEventListener('abort', task.abort, { once: true });
      state.tasks.push(task as QueueTask<unknown>);
      this.pump(key, state);
    });
  }

  private pump(key: string, state: QueueState): void {
    if (state.active) return;
    state.tasks.sort((left, right) => priorities[left.priority] - priorities[right.priority] || left.sequence - right.sequence);
    const task = state.tasks.shift();
    if (!task) {
      this.cleanup(key, state);
      return;
    }
    task.signal?.removeEventListener('abort', task.abort!);
    if (task.signal?.aborted) {
      task.reject(this.abortError(task.signal));
      this.pump(key, state);
      return;
    }

    state.active = true;
    Promise.resolve()
      .then(task.operation)
      .then(task.resolve, task.reject)
      .finally(() => {
        state.active = false;
        this.pump(key, state);
      });
  }

  private cleanup(key: string, state: QueueState): void {
    if (!state.active && state.tasks.length === 0 && this.queues.get(key) === state) this.queues.delete(key);
  }

  private abortError(signal?: AbortSignal): Error {
    return signal?.reason instanceof Error ? signal.reason : new Error('Device operation was cancelled');
  }
}

export const deviceOperationQueue = new KeyedPriorityQueue();
