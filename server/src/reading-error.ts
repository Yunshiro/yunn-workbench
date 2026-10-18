export class ReadingError extends Error {
  status: number;
  retryable: boolean;

  constructor(message: string, status = 400, retryable = false) {
    super(message);
    this.name = "ReadingError";
    this.status = status;
    this.retryable = retryable;
  }
}
