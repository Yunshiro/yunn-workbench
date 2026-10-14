export class BoardError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BoardError";
    this.status = status;
  }
}
