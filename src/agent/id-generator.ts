// ID 生成器可以在测试中注入确定性实现，避免测试依赖随机值。
export interface IdGenerator {
  next(prefix: string): string;
}

export class IncrementingIdGenerator implements IdGenerator {
  private value = 1;

  public next(prefix: string): string {
    return `${prefix}-${this.value++}`;
  }
}
