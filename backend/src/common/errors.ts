export class AppError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export const ERROR_MESSAGES = {
  overviewUnavailable: "Overview data is unavailable",
};
