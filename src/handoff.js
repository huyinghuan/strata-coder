export class HandoffError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'HandoffError';
    this.reason = reason;
  }
}
