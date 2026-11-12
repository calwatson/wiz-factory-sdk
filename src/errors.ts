export class FactoryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 500) {
    super(message);
    this.name = "FactoryError";
    this.code = code;
    this.status = status;
  }
}

export class NotFoundError extends FactoryError {
  constructor(key: string) {
    super(`Jira issue ${key} was not found.`, "not-found", 404);
    this.name = "NotFoundError";
  }
}
