/** Refreshes the room board without overlapping requests or retrying failures forever. */
export class LobbyPoller<T> {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly onResult: (result: T) => void,
    private readonly onError: (error: unknown) => void,
    private readonly interval: number,
  ) {}

  start(): void {
    this.stop();
    void this.refresh(this.generation);
  }

  stop(): void {
    this.generation += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async refresh(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    try {
      const result = await this.load();
      if (generation !== this.generation) return;
      this.onResult(result);
      if (generation === this.generation) this.timer = setTimeout(() => void this.refresh(generation), this.interval);
    } catch (error) {
      if (generation === this.generation) this.onError(error);
    }
  }
}
