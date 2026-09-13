/**
 * 按键串行锁（per-key async mutex）。
 *
 * 用于包厢预约：同一包厢的「查重 -> 扣款 -> 插入预约」临界区必须串行，
 * 否则两个并发请求可能同时通过查重，造成重复扣款和重叠预约。
 * 不同包厢使用不同的锁，互不阻塞。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** 把任务放入 key 对应队列的队尾，等前序任务结束后执行。 */
  runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    // 前序任务无论成功还是失败都要释放锁，再执行本次临界区任务
    const result = previous
      .catch(() => undefined)
      .then(() => task());

    // 队列尾部定义为「本次任务结束」时刻，供下一个任务等待
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    // 尾部 settle 后若没有更新的任务排队则清理，避免 Map 无限增长
    tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    this.tails.set(key, tail);

    return result;
  }
}
